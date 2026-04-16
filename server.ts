import express from 'express';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

app.use(express.json());

const getRedirectUri = () => {
  const baseUrl = (process.env.APP_URL || '').replace(/\/$/, '');
  return `${baseUrl}/auth/callback`;
};

const getOAuthClient = (redirectUri: string) => {
  if (!process.env.OAUTH_CLIENT_ID || !process.env.OAUTH_CLIENT_SECRET) {
    throw new Error('OAuth credentials (OAUTH_CLIENT_ID or OAUTH_CLIENT_SECRET) are missing in environment variables.');
  }
  return new google.auth.OAuth2(
    process.env.OAUTH_CLIENT_ID,
    process.env.OAUTH_CLIENT_SECRET,
    redirectUri
  );
};

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/spreadsheets'
];

const decodeBase64 = (data: string) => {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
};

const getEmailBody = (payload: any): string => {
  if (!payload) return '';
  
  let body = '';
  
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64(payload.body.data);
  }
  
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    // We can strip HTML tags later or let Gemini handle it
    return decodeBase64(payload.body.data);
  }
  
  if (payload.parts && payload.parts.length > 0) {
    for (const part of payload.parts) {
      const partBody = getEmailBody(part);
      if (partBody) {
        if (part.mimeType === 'text/plain') {
          return partBody; // Prefer plain text
        }
        body = partBody; // Fallback to HTML or other text
      }
    }
  }
  
  if (body) return body;
  
  if (payload.body?.data) {
    return decodeBase64(payload.body.data);
  }
  
  return '';
};

app.get('/api/auth/url', (req, res) => {
  try {
    const redirectUri = getRedirectUri();
    const oauth2Client = getOAuthClient(redirectUri);
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent'
    });
    res.json({ url: authUrl });
  } catch (error: any) {
    console.error('Error generating auth URL:', error);
    res.status(500).json({ error: error.message || 'Failed to generate auth URL' });
  }
});

app.get(['/auth/callback', '/auth/callback/'], async (req, res) => {
  const { code } = req.query;
  if (!code || typeof code !== 'string') {
    return res.status(400).send('No code provided');
  }

  try {
    const redirectUri = getRedirectUri();
    const oauth2Client = getOAuthClient(redirectUri);
    const { tokens } = await oauth2Client.getToken(code);
    
    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ 
                type: 'OAUTH_AUTH_SUCCESS',
                tokens: ${JSON.stringify(tokens)}
              }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error retrieving access token', error);
    res.status(500).send('Authentication failed');
  }
});

const cleanText = (value: string) => {
  if (!value) return '';
  return String(value)
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\t/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
};

const extractField = (text: string, regex: RegExp) => {
  const match = text.match(regex);
  return match ? match[1].trim() : '';
};

const parseOrder = (subject: string, body: string) => {
  const text = cleanText(body);
  
  let conversation = extractField(text, /Conversation\s*:\s*(#?\d+)/i);
  if (conversation && !conversation.startsWith('#')) {
    conversation = '#' + conversation;
  }

  const phone = cleanText(
    extractField(text, /(?:Mobile No|Mobile|Phone)\s*:\s*([0-9+\-\s]{8,20})/i)
  );

  const address = cleanText(
    extractField(
      text,
      /(?:Full Address\s*\(.*?\)|Full Address|Address)\s*:\s*(.*?)(?=\s+(?:Quantity|Product|Total|Conversation|Mobile No|Mobile|Phone)\s*:|$)/i
    )
  );

  let product = cleanText(
    extractField(
      text,
      /(?:Quantity|Product)\s*:\s*(.*?)(?=\s+Total\s*:|------\s*Conversation\s*:|\s+Conversation\s*:|$)/i
    )
  );

  const total = cleanText(
    extractField(
      text,
      /Total\s*:\s*(.*?)(?=------\s*Conversation\s*:|\s+Conversation\s*:|$)/i
    )
  ).replace(/-+$/g, '').trim();

  let customer = cleanText(
    extractField(
      text,
      /(?:Naam|Name|Customer)\s*:\s*(.*?)(?=\s+(?:Mobile No|Mobile|Phone|Address|Full Address|Product|Quantity|Total|Conversation)\s*:|$)/i
    )
  );

  // Fallback to subject parsing if not found in body
  const m = subject.match(/^New Order:\s*(.*?)\s*-\s*(.+)$/i);
  if (m) {
    if (!product) product = cleanText(m[1]);
    if (!customer) customer = cleanText(m[2]);
  }

  return {
    customer: customer || 'Not found',
    phone: phone || 'Not found',
    address: address || 'Not found',
    product: product || 'Not found',
    total: total || 'Not found',
    conversation: conversation || 'Not found'
  };
};

app.post('/api/sync', async (req, res) => {
  const { senderEmail, spreadsheetId, sheetName, tokens, syncedEmailIds = [] } = req.body;
  
  if (!tokens) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (!spreadsheetId) {
    return res.status(400).json({ error: 'Spreadsheet ID is required' });
  }

  try {
    const redirectUri = getRedirectUri();
    const oauth2Client = getOAuthClient(redirectUri);
    oauth2Client.setCredentials(tokens);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client });

    // 1. Fetch emails
    const query = senderEmail ? `from:${senderEmail}` : '';
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 50 // Limit to 50 for now to avoid timeouts
    });

    const messages = listRes.data.messages || [];
    
    // Filter out emails we have already synced
    const newMessages = messages.filter(msg => !syncedEmailIds.includes(msg.id));

    if (newMessages.length === 0) {
      return res.json({ success: true, count: 0, message: 'No new emails found.', newIds: [] });
    }

    const emailData = [];
    const processedIds = [];

    for (const msg of newMessages) {
      if (!msg.id) continue;
      const msgRes = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full',
      });

      const headers = msgRes.data.payload?.headers || [];
      const getHeader = (name: string) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      const date = getHeader('Date');
      const from = getHeader('From');
      const subject = getHeader('Subject');
      
      const bodyText = getEmailBody(msgRes.data.payload);
      const snippet = msgRes.data.snippet || '';
      
      // Strip HTML tags for regex parsing
      const plainTextBody = (bodyText || snippet)
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&');

      const orderData = parseOrder(subject, plainTextBody);

      emailData.push([
        date,
        from,
        subject,
        orderData.customer,
        orderData.phone,
        orderData.address,
        orderData.total,
        orderData.conversation
      ]);
      processedIds.push(msg.id);
    }

    // 2. Write to Google Sheets
    const range = sheetName ? `${sheetName}!A:H` : 'A:H';
    
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: emailData
      }
    });

    const formattedData = emailData.map(row => ({
      date: row[0],
      from: row[1],
      subject: row[2],
      name: row[3],
      mobile: row[4],
      address: row[5],
      totalAmount: row[6],
      conversationId: row[7]
    }));

    res.json({ success: true, count: emailData.length, newIds: processedIds, syncedData: formattedData });
  } catch (error: any) {
    console.error('Sync error:', error);
    
    let errorMessage = error.message || 'Failed to sync emails';
    
    // Check if it's a Google API error
    if (error.response && error.response.data && error.response.data.error) {
      errorMessage = error.response.data.error.message || errorMessage;
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;
