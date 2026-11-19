import { useEffect, useState } from 'react';
import {
  History,
  LogOut,
  Menu,
  MessageSquarePlus,
  PhoneCall,
  ShieldCheck,
  Smartphone,
  X,
} from 'lucide-react';
import { AdminDashboard } from './components/AdminDashboard.tsx';
import { AuthScreen } from './components/AuthScreen.tsx';
import {
  FeaturePhoneReceiver,
  type ReceiverDeviceMode,
} from './components/FeaturePhoneReceiver.tsx';
import { LiveCallModal, type ActiveCallSession } from './components/LiveCallModal.tsx';
import { MessageComposer } from './components/MessageComposer.tsx';
import { SentHistory } from './components/SentHistory.tsx';
import { apiRequest, getStoredToken, setStoredToken } from './lib/api.ts';
import { parseRwandaPhone } from './lib/rwandaPhone.ts';
import type { CallRecord, GatewayStatusInfo, MessageRecord, UserProfile } from './types.ts';

type WorkspaceTab = 'compose' | 'history' | 'receiver' | 'admin';

function readReceiverQueryPhone(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = new URLSearchParams(window.location.search).get('receiver');
  if (!raw) return null;
  const parsed = parseRwandaPhone(raw);
  return parsed.valid ? parsed.e164 : null;
}

function readReceiverQueryDevice(): ReceiverDeviceMode | undefined {
  if (typeof window === 'undefined') return undefined;
  const raw = new URLSearchParams(window.location.search).get('device');
  if (raw === 'tablet' || raw === 'smartphone' || raw === 'feature') {
    return raw;
  }
  const pathLower = window.location.pathname.toLowerCase();
  if (pathLower === '/tablet') return 'tablet';
  if (pathLower === '/smartphone') return 'smartphone';
  return undefined;
}

function isReceiverPath(): boolean {
  if (typeof window === 'undefined') return false;
  const pathLower = window.location.pathname.toLowerCase();
  return pathLower === '/receiver' || pathLower === '/tablet' || pathLower === '/smartphone';
}

export default function App() {
  const initialReceiverParam = readReceiverQueryPhone();
  const initialDeviceParam = readReceiverQueryDevice();
  const openReceiverInitially = Boolean(initialReceiverParam) || isReceiverPath();
  const [user, setUser] = useState<UserProfile | null>(null);
  const [gateway, setGateway] = useState<GatewayStatusInfo>({
    activeProvider: 'local_relay',
    pindoConfigured: false,
    africasTalkingConfigured: false,
    twilioConfigured: false,
    httpGatewayConfigured: false,
    appUrl: '',
  });
  const [booting, setBooting] = useState(true);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(
    openReceiverInitially ? 'receiver' : 'compose'
  );
  const [publicReceiverMode, setPublicReceiverMode] = useState(openReceiverInitially);
  const [receiverPhone, setReceiverPhone] = useState<string>(initialReceiverParam || '');
  const [receiverDevice, setReceiverDevice] = useState<ReceiverDeviceMode | undefined>(
    initialDeviceParam
  );
  const [myMessages, setMyMessages] = useState<MessageRecord[]>([]);
  const [myInboxCount, setMyInboxCount] = useState(0);
  const [liveIncomingAlert, setLiveIncomingAlert] = useState<MessageRecord | null>(null);
  const [incomingCallBanner, setIncomingCallBanner] = useState<{
    call: CallRecord;
    offer: RTCSessionDescriptionInit | null;
  } | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCallSession | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  async function hydrateSession() {
    const token = getStoredToken();
    if (!token) {
      setBooting(false);
      return;
    }
    try {
      const res = await apiRequest<{ user: UserProfile; gateway: GatewayStatusInfo }>('/api/auth/me');
      setUser(res.user);
      setGateway(res.gateway);
    } catch {
      setStoredToken(null);
      setUser(null);
    } finally {
      setBooting(false);
    }
  }

  async function loadMyMessages() {
    if (!user) return;
    setLoadingMessages(true);
    try {
      const res = await apiRequest<{ messages: MessageRecord[] }>('/api/messages/mine');
      setMyMessages(res.messages);
    } catch {
      // Ignore transient error
    } finally {
      setLoadingMessages(false);
    }
  }

  useEffect(() => {
    void hydrateSession();
  }, []);

  useEffect(() => {
    if (!user) {
      setMyInboxCount(0);
      setLiveIncomingAlert(null);
      return;
    }
    void loadMyMessages();

    let cancelled = false;
    void apiRequest<{ messages: MessageRecord[] }>(
      `/api/receiver/messages?phone=${encodeURIComponent(user.phone)}`
    )
      .then((res) => {
        if (!cancelled) setMyInboxCount(res.messages.length);
      })
      .catch(() => {
        // Ignore silent background load
      });

    const es = new EventSource(`/api/receiver/stream?phone=${encodeURIComponent(user.phone)}`);
    es.addEventListener('new_message', (ev) => {
      try {
        const incoming = JSON.parse((ev as MessageEvent<string>).data) as MessageRecord;
        setMyInboxCount((c) => c + 1);
        setLiveIncomingAlert(incoming);
      } catch {
        // Ignore parse error
      }
    });
    es.addEventListener('incoming_call', (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent<string>).data) as {
          call: CallRecord;
          offer: RTCSessionDescriptionInit | null;
        };
        setIncomingCallBanner(payload);
      } catch {
        // Ignore parse error
      }
    });
    es.addEventListener('call_ended', (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent<string>).data) as { call: CallRecord };
        setIncomingCallBanner((prev) => (prev?.call.id === payload.call.id ? null : prev));
      } catch {
        // Ignore parse error
      }
    });

    return () => {
      cancelled = true;
      es.close();
    };
  }, [user]);

  async function handleLogout() {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' });
    } catch {
      // Ignore logout network errors
    }
    setStoredToken(null);
    setUser(null);
    setMyMessages([]);
    setIncomingCallBanner(null);
    setActiveCall(null);
    setActiveTab('compose');
  }

  function handleInspectPhone(phoneE164: string, device?: ReceiverDeviceMode) {
    setReceiverPhone(phoneE164);
    if (device) {
      setReceiverDevice(device);
    }
    setActiveTab('receiver');
    setMobileMenuOpen(false);
  }

  function handleStartCall(phoneE164: string, device: ReceiverDeviceMode = 'smartphone') {
    setActiveCall({
      direction: 'outgoing',
      recipientPhone: phoneE164,
      targetDevice: device,
    });
  }

  function handleAnswerLiveCall(call: CallRecord, offer: RTCSessionDescriptionInit | null) {
    setIncomingCallBanner(null);
    setActiveCall({
      direction: 'incoming',
      call,
      offer,
    });
  }

  if (booting) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <p className="text-sm font-medium text-slate-600">Loading KigaliRelay workspace...</p>
      </div>
    );
  }

  // Unauthenticated Public Feature-Phone Receiver view
  if (!user && publicReceiverMode) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col">
        <header className="bg-white border-b border-slate-200 px-6 lg:px-10 h-16 flex items-center justify-between gap-8">
          <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            KigaliRelay
          </span>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => setPublicReceiverMode(false)}
              className="px-4 py-2 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              Sign In / Create Account
            </button>
          </div>
        </header>
        <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-8">
          <FeaturePhoneReceiver initialPhone={receiverPhone} initialDevice={receiverDevice} />
        </main>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        onAuthenticated={(loggedInUser, gatewayInfo) => {
          setUser(loggedInUser);
          if (gatewayInfo) setGateway(gatewayInfo);
          setPublicReceiverMode(false);
          setActiveTab(loggedInUser.role === 'admin' ? 'admin' : 'compose');
        }}
        onOpenReceiver={() => setPublicReceiverMode(true)}
      />
    );
  }

  const navItems: Array<{ id: WorkspaceTab; label: string; icon: typeof MessageSquarePlus }> = [
    { id: 'compose', label: 'Compose & Record', icon: MessageSquarePlus },
    { id: 'history', label: 'Sent History', icon: History },
    { id: 'receiver', label: 'Phone & Tablet', icon: Smartphone },
    ...(user.role === 'admin'
      ? [{ id: 'admin' as const, label: 'Admin Console', icon: ShieldCheck }]
      : []),
  ];

  const activeTitle =
    activeTab === 'compose'
      ? 'Compose SMS & Voice Audio'
      : activeTab === 'history'
        ? 'Sent History'
        : activeTab === 'receiver'
          ? 'Rwandan Phone & Tablet Receiver'
          : 'Administrator Console';

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col bg-white border-r border-slate-200 shrink-0">
        <div className="h-16 px-6 flex items-center border-b border-slate-200">
          <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap">
            KigaliRelay
          </span>
        </div>

        <nav className="flex-1 p-4 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-teal-50 text-teal-900'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-teal-700' : 'text-slate-500'}`} />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-3">
          <div className="space-y-0.5">
            <p className="text-sm font-semibold text-slate-900 truncate">{user.fullName}</p>
            <p className="text-xs font-mono text-slate-500 tabular-nums">{user.phone}</p>
            <p className="text-xs text-slate-500">
              {user.role === 'admin' ? 'Administrator' : 'Member'} · {user.carrier}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden bg-slate-900/50 flex">
          <div className="w-64 bg-white h-full flex flex-col border-r border-slate-200">
            <div className="h-16 px-5 flex items-center justify-between border-b border-slate-200">
              <span className="text-lg font-bold text-slate-900">KigaliRelay</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-800"
                aria-label="Close navigation"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-4 space-y-1">
              {navItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-sm font-medium rounded-lg ${
                      active ? 'bg-teal-50 text-teal-900' : 'text-slate-600 hover:bg-slate-100'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {item.label}
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-slate-200">
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg"
              >
                <LogOut className="w-3.5 h-3.5" />
                Sign Out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-16 bg-white border-b border-slate-200 px-6 flex items-center justify-between gap-6">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 text-slate-600 hover:text-slate-900"
              aria-label="Open navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-base font-semibold text-slate-900 truncate">{activeTitle}</h1>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => {
                setLiveIncomingAlert(null);
                handleInspectPhone(user.phone);
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums"
            >
              <Smartphone className="w-3.5 h-3.5" />
              My Inbox ({myInboxCount})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('compose')}
              className="px-3.5 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              New Message
            </button>
          </div>
        </header>

        {incomingCallBanner && (
          <div className="bg-emerald-900 text-white px-6 py-3 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2.5">
              <PhoneCall className="w-4 h-4 text-emerald-300 shrink-0" />
              <span>
                Incoming Live Voice Call from <strong>{incomingCallBanner.call.callerName}</strong>{' '}
                (<span className="font-mono">{incomingCallBanner.call.callerPhone}</span>)
              </span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() =>
                  handleAnswerLiveCall(incomingCallBanner.call, incomingCallBanner.offer)
                }
                className="px-3 py-1.5 font-semibold bg-white text-emerald-950 rounded hover:bg-emerald-50 cursor-pointer whitespace-nowrap"
              >
                Answer Call
              </button>
              <button
                type="button"
                onClick={() => {
                  const id = incomingCallBanner.call.id;
                  setIncomingCallBanner(null);
                  void apiRequest(`/api/calls/${id}/end`, {
                    method: 'POST',
                    body: JSON.stringify({ reason: 'declined' }),
                  }).catch(() => {});
                }}
                className="px-3 py-1.5 font-semibold bg-red-600 text-white rounded hover:bg-red-700 cursor-pointer whitespace-nowrap"
              >
                Decline
              </button>
            </div>
          </div>
        )}

        {liveIncomingAlert && (
          <div className="bg-teal-900 text-white px-6 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
            <span>
              Incoming {liveIncomingAlert.mode.toUpperCase()} for{' '}
              <strong className="font-mono">{liveIncomingAlert.recipientPhone}</strong> from{' '}
              <strong>{liveIncomingAlert.senderName}</strong>
            </span>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  const targetPhone = liveIncomingAlert.recipientPhone;
                  setLiveIncomingAlert(null);
                  handleInspectPhone(targetPhone);
                }}
                className="px-2.5 py-1 font-semibold bg-white text-teal-900 rounded hover:bg-teal-50 cursor-pointer whitespace-nowrap"
              >
                Open &amp; Listen
              </button>
              <button
                type="button"
                onClick={() => setLiveIncomingAlert(null)}
                className="px-2 py-1 text-teal-200 hover:text-white cursor-pointer"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        <main className="flex-1 max-w-6xl w-full mx-auto p-6">
          {activeTab === 'compose' && (
            <MessageComposer
              gateway={gateway}
              onSent={(msg) => setMyMessages((prev) => [msg, ...prev])}
              onInspectPhone={handleInspectPhone}
              onStartCall={handleStartCall}
            />
          )}
          {activeTab === 'history' && (
            <SentHistory
              messages={myMessages}
              loading={loadingMessages}
              onRefresh={() => void loadMyMessages()}
              onInspectPhone={handleInspectPhone}
              onStartCall={handleStartCall}
            />
          )}
          {activeTab === 'receiver' && (
            <FeaturePhoneReceiver
              initialPhone={receiverPhone}
              initialDevice={receiverDevice}
              onStartCall={handleStartCall}
              onAnswerLiveCall={handleAnswerLiveCall}
            />
          )}
          {activeTab === 'admin' && user.role === 'admin' && (
            <AdminDashboard currentUserId={user.id} onInspectPhone={handleInspectPhone} />
          )}
        </main>
      </div>

      {activeCall && <LiveCallModal session={activeCall} onClose={() => setActiveCall(null)} />}
    </div>
  );
}
