import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Toaster } from '@/components/ui/sonner';
import { toast } from 'sonner';
import { Mail, FileSpreadsheet, ArrowRight, LogOut, Loader2, RefreshCw } from 'lucide-react';

type SyncedEmail = {
  date: string;
  from: string;
  subject: string;
  name: string;
  mobile: string;
  address: string;
  totalAmount: string;
  conversationId: string;
};

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  
  const [senderEmail, setSenderEmail] = useState(() => localStorage.getItem('config_senderEmail') || '');
  const [spreadsheetId, setSpreadsheetId] = useState(() => localStorage.getItem('config_spreadsheetId') || '');
  const [sheetName, setSheetName] = useState(() => localStorage.getItem('config_sheetName') || 'Sheet1');
  const [autoSync, setAutoSync] = useState(() => localStorage.getItem('config_autoSync') === 'true');
  const [syncedEmails, setSyncedEmails] = useState<SyncedEmail[]>([]);

  // Persist config changes
  useEffect(() => {
    localStorage.setItem('config_senderEmail', senderEmail);
    localStorage.setItem('config_spreadsheetId', spreadsheetId);
    localStorage.setItem('config_sheetName', sheetName);
    localStorage.setItem('config_autoSync', String(autoSync));
  }, [senderEmail, spreadsheetId, sheetName, autoSync]);

  useEffect(() => {
    // Handle OAuth callback directly in the frontend if we land here
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    
    if (code && window.location.pathname.includes('/auth/callback')) {
      // We are in the popup window, but Vercel routed us to the frontend instead of the backend
      // We need to send this code to our backend API to exchange for tokens
      setIsLoading(true);
      fetch(`/api/exchange-token?code=${encodeURIComponent(code)}`)
        .then(res => res.json())
        .then(data => {
          if (data.tokens) {
            if (window.opener) {
              window.opener.postMessage({ 
                type: 'OAUTH_AUTH_SUCCESS',
                tokens: data.tokens
              }, '*');
              window.close();
            } else {
              localStorage.setItem('google_tokens', JSON.stringify(data.tokens));
              window.location.href = '/';
            }
          } else {
            toast.error('Failed to exchange token');
            setIsLoading(false);
          }
        })
        .catch(err => {
          console.error('Token exchange error:', err);
          toast.error('Error connecting to Google');
          setIsLoading(false);
        });
      return;
    }

    // Check local storage for tokens
    const storedTokens = localStorage.getItem('google_tokens');
    if (storedTokens) {
      setIsAuthenticated(true);
    }
    
    // Load previously synced emails for the table
    const storedEmails = localStorage.getItem('synced_emails_data');
    if (storedEmails) {
      try {
        setSyncedEmails(JSON.parse(storedEmails));
      } catch (e) {
        console.error('Failed to parse stored emails');
      }
    }
    
    setIsLoading(false);

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        const tokens = event.data.tokens;
        if (tokens) {
          localStorage.setItem('google_tokens', JSON.stringify(tokens));
          setIsAuthenticated(true);
          toast.success('Successfully connected to Google!');
        }
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // Auto Sync Effect
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (autoSync && isAuthenticated && spreadsheetId) {
      // Run every 2 minutes
      interval = setInterval(() => {
        handleSync(true);
      }, 2 * 60 * 1000);
    }
    return () => clearInterval(interval);
  }, [autoSync, isAuthenticated, spreadsheetId, senderEmail, sheetName]);

  const handleConnect = async () => {
    try {
      const response = await fetch('/api/auth/url');
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to get auth URL');
      }
      const { url } = await response.json();

      const authWindow = window.open(
        url,
        'oauth_popup',
        'width=600,height=700'
      );

      if (!authWindow) {
        toast.error('Please allow popups for this site to connect your account.');
      }
    } catch (error: any) {
      console.error('OAuth error:', error);
      toast.error(error.message || 'Failed to initiate connection.');
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('google_tokens');
    setIsAuthenticated(false);
    setAutoSync(false);
    toast.success('Logged out successfully');
  };

  const handleSync = async (isBackground = false) => {
    if (!spreadsheetId) {
      if (!isBackground) toast.error('Please enter a Spreadsheet ID');
      return;
    }

    const storedTokens = localStorage.getItem('google_tokens');
    if (!storedTokens) {
      if (!isBackground) toast.error('Not authenticated. Please connect again.');
      setIsAuthenticated(false);
      setAutoSync(false);
      return;
    }

    if (!isBackground) setIsSyncing(true);
    
    try {
      const tokens = JSON.parse(storedTokens);
      const storedIds = JSON.parse(localStorage.getItem('synced_email_ids') || '[]');

      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          senderEmail, 
          spreadsheetId, 
          sheetName, 
          tokens,
          syncedEmailIds: storedIds
        })
      });
      
      const data = await res.json();
      
      if (res.ok) {
        if (data.newIds && data.newIds.length > 0) {
          const updatedIds = [...storedIds, ...data.newIds];
          localStorage.setItem('synced_email_ids', JSON.stringify(updatedIds));
          
          if (data.syncedData) {
            setSyncedEmails(prev => {
              const newData = [...data.syncedData, ...prev];
              localStorage.setItem('synced_emails_data', JSON.stringify(newData.slice(0, 50))); // Keep last 50
              return newData;
            });
          }
          
          toast.success(`Successfully synced ${data.count} new emails to Google Sheets!`);
        } else {
          if (!isBackground) toast.info(data.message || 'No new emails found.');
        }
      } else {
        if (!isBackground) toast.error(data.error || 'Failed to sync emails');
      }
    } catch (error) {
      console.error('Sync error:', error);
      if (!isBackground) toast.error('An unexpected error occurred during sync.');
    } finally {
      if (!isBackground) setIsSyncing(false);
    }
  };

  const handleClearHistory = () => {
    localStorage.removeItem('synced_email_ids');
    localStorage.removeItem('synced_emails_data');
    setSyncedEmails([]);
    toast.success('Sync history cleared! You can now re-sync old emails.');
  };

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-zinc-50">
        <Loader2 className="h-8 w-8 animate-spin text-zinc-500" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 py-12 px-4 sm:px-6 lg:px-8">
      <Toaster position="top-center" />
      <div className="max-w-3xl mx-auto space-y-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-zinc-900 flex items-center justify-center gap-3">
            <Mail className="h-8 w-8 text-blue-500" />
            Mail to Sheets
            <FileSpreadsheet className="h-8 w-8 text-green-500" />
          </h1>
          <p className="mt-4 text-lg text-zinc-600">
            Automatically collect emails from Gmail and export them to a Google Spreadsheet.
          </p>
        </div>

        {!isAuthenticated ? (
          <Card className="max-w-md mx-auto">
            <CardHeader>
              <CardTitle>Connect your account</CardTitle>
              <CardDescription>
                We need access to your Gmail to read emails and Google Sheets to write the data.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button onClick={handleConnect} className="w-full" size="lg">
                Connect Google Account
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-6">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Configuration</CardTitle>
                  <CardDescription>Set up your email filter and destination sheet.</CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={handleLogout}>
                  <LogOut className="h-4 w-4 mr-2" />
                  Disconnect
                </Button>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="space-y-2">
                  <Label htmlFor="senderEmail">Sender Email Address (Optional)</Label>
                  <Input 
                    id="senderEmail" 
                    placeholder="e.g., alerts@bank.com" 
                    value={senderEmail}
                    onChange={(e) => setSenderEmail(e.target.value)}
                  />
                  <p className="text-sm text-zinc-500">
                    Only emails from this specific sender will be synced. Leave blank to sync all new emails.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <Label htmlFor="spreadsheetId">Spreadsheet ID <span className="text-red-500">*</span></Label>
                    <Input 
                      id="spreadsheetId" 
                      placeholder="1BxiMVs0XRYFg..." 
                      value={spreadsheetId}
                      onChange={(e) => setSpreadsheetId(e.target.value)}
                    />
                    <p className="text-xs text-zinc-500">
                      The long string of characters in your Google Sheet URL.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="sheetName">Sheet Name</Label>
                    <Input 
                      id="sheetName" 
                      placeholder="Sheet1" 
                      value={sheetName}
                      onChange={(e) => setSheetName(e.target.value)}
                    />
                    <p className="text-xs text-zinc-500">
                      The name of the specific tab (defaults to Sheet1).
                    </p>
                  </div>
                </div>

                <div className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <Label className="text-base">Auto Sync</Label>
                    <p className="text-sm text-zinc-500">
                      Automatically check for and sync new emails every 2 minutes while this tab is open.
                    </p>
                  </div>
                  <Switch
                    checked={autoSync}
                    onCheckedChange={setAutoSync}
                  />
                </div>
              </CardContent>
              <CardFooter className="flex flex-col space-y-3">
                <Button 
                  onClick={() => handleSync(false)} 
                  className="w-full" 
                  size="lg"
                  disabled={isSyncing || !spreadsheetId}
                >
                  {isSyncing ? (
                    <>
                      <Loader2 className="h-5 w-5 mr-2 animate-spin" />
                      Syncing Emails...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="h-5 w-5 mr-2" />
                      Sync Now
                    </>
                  )}
                </Button>
                <Button variant="ghost" size="sm" onClick={handleClearHistory} className="w-full text-zinc-500">
                  Clear Sync History (Test Again)
                </Button>
              </CardFooter>
            </Card>
            
            <Card className="bg-blue-50 border-blue-100">
              <CardContent className="p-4 text-sm text-blue-800">
                <strong>Note:</strong> This tool uses Regex to read the email body and extract the <strong>Name, Mobile, Address, Total Amount, and Conversation ID</strong> based on the Aireply24 format. The data exported to your sheet will be: Date, Sender, Subject, Name, Mobile, Address, Total Amount, and Conversation ID. <br/><br/>
                <strong>Auto Sync:</strong> Because this is a web app, the browser tab must remain open for Auto Sync to run continuously. It will skip emails that have already been synced.
              </CardContent>
            </Card>

            {syncedEmails.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Recently Synced Emails</CardTitle>
                  <CardDescription>Data recently extracted and sent to your spreadsheet.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="rounded-md border overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Sender</TableHead>
                          <TableHead>Name</TableHead>
                          <TableHead>Mobile</TableHead>
                          <TableHead>Address</TableHead>
                          <TableHead>Total</TableHead>
                          <TableHead>Conv. ID</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {syncedEmails.map((email, i) => (
                          <TableRow key={i}>
                            <TableCell className="whitespace-nowrap">{email.date}</TableCell>
                            <TableCell className="whitespace-nowrap">{email.from}</TableCell>
                            <TableCell className="whitespace-nowrap">{email.name}</TableCell>
                            <TableCell className="whitespace-nowrap">{email.mobile}</TableCell>
                            <TableCell className="max-w-[200px] truncate" title={email.address}>{email.address}</TableCell>
                            <TableCell className="whitespace-nowrap">{email.totalAmount}</TableCell>
                            <TableCell className="whitespace-nowrap">{email.conversationId}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
