import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Ban,
  CheckCircle,
  Copy,
  MessageSquare,
  RefreshCw,
  Search,
  Server,
  Shield,
  Trash2,
  Users,
} from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import type { ActivityLog, AdminOverview, MessageRecord, UserProfile } from '../types.ts';

interface AdminDashboardProps {
  currentUserId: string;
  onInspectPhone: (phoneE164: string) => void;
}

type AdminTab = 'users' | 'messages' | 'activities' | 'gateway';

interface PendingConfirm {
  title: string;
  description: string;
  confirmLabel: string;
  danger: boolean;
  onConfirm: () => Promise<void>;
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  currentUserId,
  onInspectPhone,
}) => {
  const [activeTab, setActiveTab] = useState<AdminTab>('users');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [voiceXmlPreview, setVoiceXmlPreview] = useState<{
    url: string;
    xml: string;
    loading: boolean;
  } | null>(null);

  async function loadAllAdminData() {
    setLoading(true);
    setError(null);
    try {
      const [ovRes, usrRes, msgRes, actRes] = await Promise.all([
        apiRequest<{ overview: AdminOverview }>('/api/admin/overview'),
        apiRequest<{ users: UserProfile[] }>('/api/admin/users'),
        apiRequest<{ messages: MessageRecord[] }>('/api/admin/messages'),
        apiRequest<{ activities: ActivityLog[] }>('/api/admin/activities'),
      ]);
      setOverview(ovRes.overview);
      setUsers(usrRes.users);
      setMessages(msgRes.messages);
      setActivities(actRes.activities);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load admin console.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAllAdminData();
  }, []);

  async function toggleUserStatus(user: UserProfile) {
    const nextStatus = user.status === 'active' ? 'suspended' : 'active';
    setBusyId(user.id);
    setError(null);
    try {
      await apiRequest(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      await loadAllAdminData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user status.');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleUserRole(user: UserProfile) {
    const nextRole = user.role === 'admin' ? 'user' : 'admin';
    setBusyId(user.id);
    setError(null);
    try {
      await apiRequest(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: nextRole }),
      });
      await loadAllAdminData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update user role.');
    } finally {
      setBusyId(null);
    }
  }

  function requestDeleteUser(user: UserProfile) {
    setPendingConfirm({
      title: `Delete ${user.fullName}?`,
      description: `This permanently deletes ${user.email} (${user.phone}) and all their dispatched messages and audio files.`,
      confirmLabel: 'Delete Account',
      danger: true,
      onConfirm: async () => {
        await apiRequest(`/api/admin/users/${user.id}`, { method: 'DELETE' });
        await loadAllAdminData();
      },
    });
  }

  async function updateMessageStatus(msg: MessageRecord, status: MessageRecord['status']) {
    setBusyId(msg.id);
    setError(null);
    try {
      await apiRequest(`/api/admin/messages/${msg.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      await loadAllAdminData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update message status.');
    } finally {
      setBusyId(null);
    }
  }

  function requestDeleteMessage(msg: MessageRecord) {
    setPendingConfirm({
      title: 'Delete Dispatched Message?',
      description: `Permanently delete the ${msg.mode.toUpperCase()} message from ${msg.senderName} to ${msg.recipientPhone} and its audio recording.`,
      confirmLabel: 'Delete Message',
      danger: true,
      onConfirm: async () => {
        await apiRequest(`/api/admin/messages/${msg.id}`, { method: 'DELETE' });
        await loadAllAdminData();
      },
    });
  }

  async function copyEndpoint(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      // Clipboard blocked in restricted context
    }
  }

  async function previewVoiceXml(url: string) {
    setVoiceXmlPreview({ url, xml: '', loading: true });
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/xml' },
      });
      const text = await res.text();
      setVoiceXmlPreview({ url, xml: text, loading: false });
    } catch (err) {
      setVoiceXmlPreview({
        url,
        xml: err instanceof Error ? err.message : 'Failed to fetch Voice XML.',
        loading: false,
      });
    }
  }

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.fullName.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.phone.toLowerCase().includes(q) ||
        u.carrier.toLowerCase().includes(q)
    );
  }, [users, search]);

  const filteredMessages = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return messages;
    return messages.filter(
      (m) =>
        m.senderName.toLowerCase().includes(q) ||
        m.recipientPhone.toLowerCase().includes(q) ||
        m.textBody.toLowerCase().includes(q) ||
        m.gatewayReference.toLowerCase().includes(q)
    );
  }, [messages, search]);

  const filteredActivities = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return activities;
    return activities.filter(
      (a) =>
        a.userName.toLowerCase().includes(q) ||
        a.userEmail.toLowerCase().includes(q) ||
        a.action.toLowerCase().includes(q) ||
        a.details.toLowerCase().includes(q)
    );
  }, [activities, search]);

  return (
    <div className="space-y-6">
      {/* 4-Column KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Registered Users</p>
          <p className="text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {overview?.totalUsers ?? '—'}
          </p>
          <p className="text-xs text-slate-600 mt-1 tabular-nums">
            {overview?.activeUsers ?? 0} active · {overview?.suspendedUsers ?? 0} suspended
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Total Dispatched</p>
          <p className="text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {overview?.totalMessages ?? '—'}
          </p>
          <p className="text-xs text-slate-600 mt-1 tabular-nums">
            {overview?.smsMessages ?? 0} SMS · {overview?.voiceMessages ?? 0} Voice recordings
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Rwandan Carrier Split</p>
          <p className="text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {overview ? `${overview.mtnMessages} / ${overview.airtelMessages}` : '—'}
          </p>
          <p className="text-xs text-slate-600 mt-1">MTN Rwanda · Airtel Rwanda</p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <p className="text-xs font-medium text-slate-500">Audited Events</p>
          <p className="text-2xl font-bold text-slate-900 mt-1 tabular-nums">
            {activities.length}
          </p>
          <p className="text-xs text-slate-600 mt-1">
            {overview?.gateway.activeProvider === 'pindo'
              ? 'Pindo Rwanda Live'
              : overview?.gateway.activeProvider === 'africas_talking'
                ? "Africa's Talking Live"
                : overview?.gateway.activeProvider === 'twilio'
                  ? 'Twilio Live'
                  : overview?.gateway.activeProvider === 'http_gateway'
                    ? 'HTTP SIM Gateway Live'
                    : 'In-App Relay Active'}
          </p>
        </div>
      </div>

      {error && (
        <div role="alert" className="p-3 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg">
          {error}
        </div>
      )}

      {/* Main Admin Table Panel */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(
              [
                { id: 'users', label: 'Users', icon: Users },
                { id: 'messages', label: 'Messages & Audio', icon: MessageSquare },
                { id: 'activities', label: 'Activity Log', icon: Activity },
                { id: 'gateway', label: 'Gateway Config', icon: Server },
              ] as const
            ).map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    activeTab === tab.id
                      ? 'bg-white text-slate-900 shadow-sm'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3">
            {activeTab !== 'gateway' && (
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search records..."
                  className="pl-9 pr-3 py-1.5 text-sm bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
                />
              </div>
            )}
            <button
              type="button"
              onClick={() => void loadAllAdminData()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        </div>

        {/* Users Tab */}
        {activeTab === 'users' && (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-4">User</th>
                  <th className="py-3 px-4">Rwandan Phone</th>
                  <th className="py-3 px-4">Role &amp; Status</th>
                  <th className="py-3 px-4 text-right">Sent</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-10 px-4 text-center text-sm text-slate-500">
                      No user accounts match your search.
                    </td>
                  </tr>
                ) : (
                  filteredUsers.map((u) => {
                    const isSelf = u.id === currentUserId;
                    return (
                      <tr key={u.id} className="hover:bg-slate-50/70 align-middle">
                        <td className="py-3 px-4 min-w-[160px]">
                          <div className="font-medium text-slate-900">{u.fullName}</div>
                          <div className="text-xs text-slate-500 break-all">{u.email}</div>
                        </td>
                        <td className="py-3 px-4 font-mono text-xs tabular-nums whitespace-nowrap">
                          <div className="text-slate-900">{u.phone}</div>
                          <div className="text-slate-500">{u.carrier}</div>
                        </td>
                        <td className="py-3 px-4 text-xs whitespace-nowrap">
                          <div>
                            <span className="font-medium text-slate-800">
                              {u.role === 'admin' ? 'Administrator' : 'Standard User'}
                            </span>
                            <span className="mx-1.5 text-slate-400">·</span>
                            <span
                              className={`font-medium ${
                                u.status === 'active' ? 'text-emerald-700' : 'text-red-700'
                              }`}
                            >
                              {u.status === 'active' ? 'Active' : 'Suspended'}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-400 font-mono tabular-nums mt-0.5">
                            {u.lastLoginAt
                              ? `Last login ${new Date(u.lastLoginAt).toLocaleDateString()}`
                              : 'Never signed in'}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono text-xs tabular-nums text-slate-700">
                          {u.messageCount ?? 0}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="flex flex-wrap items-center justify-end gap-1.5">
                            <button
                              type="button"
                              disabled={isSelf || busyId === u.id}
                              onClick={() => void toggleUserStatus(u)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 rounded-md whitespace-nowrap cursor-pointer"
                            >
                              {u.status === 'active' ? (
                                <>
                                  <Ban className="w-3.5 h-3.5" />
                                  Suspend
                                </>
                              ) : (
                                <>
                                  <CheckCircle className="w-3.5 h-3.5" />
                                  Activate
                                </>
                              )}
                            </button>

                            <button
                              type="button"
                              disabled={isSelf || busyId === u.id}
                              onClick={() => void toggleUserRole(u)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 rounded-md whitespace-nowrap cursor-pointer"
                            >
                              <Shield className="w-3.5 h-3.5" />
                              {u.role === 'admin' ? 'Set User' : 'Make Admin'}
                            </button>

                            <button
                              type="button"
                              disabled={isSelf || busyId === u.id}
                              onClick={() => requestDeleteUser(u)}
                              aria-label={`Delete ${u.fullName}`}
                              className="p-1.5 text-red-700 hover:bg-red-50 disabled:opacity-40 rounded-md cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Messages & Audio Tab */}
        {activeTab === 'messages' && (
          <div className="divide-y divide-slate-200 max-h-[560px] overflow-y-auto">
            {filteredMessages.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-500">
                {search.trim()
                  ? 'No dispatched messages match your search.'
                  : 'No dispatched messages recorded yet.'}
              </div>
            ) : (
              filteredMessages.map((msg) => (
                <div key={msg.id} className="p-5 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600 tabular-nums">
                      <span className="font-semibold text-slate-900">{msg.senderName}</span>
                      <span aria-hidden="true">→</span>
                      <span className="font-mono font-semibold text-slate-900">
                        {msg.recipientPhone}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{msg.recipientCarrier}</span>
                      <span aria-hidden="true">·</span>
                      <span>{msg.mode.toUpperCase()}</span>
                      <span aria-hidden="true">·</span>
                      <span
                        className={`font-medium ${
                          msg.status === 'cancelled' || msg.status === 'failed'
                            ? 'text-red-700'
                            : 'text-emerald-700'
                        }`}
                      >
                        {msg.status}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>{new Date(msg.createdAt).toLocaleString()}</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onInspectPhone(msg.recipientPhone)}
                        className="px-2.5 py-1 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 rounded-md whitespace-nowrap cursor-pointer"
                      >
                        Open Phone
                      </button>
                      {msg.status !== 'cancelled' ? (
                        <button
                          type="button"
                          disabled={busyId === msg.id}
                          onClick={() => void updateMessageStatus(msg, 'cancelled')}
                          className="px-2.5 py-1 text-xs font-medium text-amber-800 bg-amber-50 hover:bg-amber-100 rounded-md whitespace-nowrap cursor-pointer"
                        >
                          Block / Cancel
                        </button>
                      ) : (
                        <button
                          type="button"
                          disabled={busyId === msg.id}
                          onClick={() => void updateMessageStatus(msg, 'delivered_relay')}
                          className="px-2.5 py-1 text-xs font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-md whitespace-nowrap cursor-pointer"
                        >
                          Restore
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busyId === msg.id}
                        onClick={() => requestDeleteMessage(msg)}
                        className="p-1.5 text-red-700 hover:bg-red-50 rounded-md cursor-pointer"
                        aria-label="Delete message"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {msg.textBody && (
                    <p className="text-sm text-slate-800 whitespace-pre-wrap">{msg.textBody}</p>
                  )}

                  {msg.audioUrl && (
                    <div className="flex flex-wrap items-center gap-3">
                      <audio controls src={msg.audioUrl} className="h-9 max-w-md w-full" />
                      <span className="text-xs font-mono text-slate-500 tabular-nums">
                        {msg.audioDurationSec}s · IVR *180*{msg.ivrCode}#
                      </span>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        {/* Activity Audit Log Tab */}
        {activeTab === 'activities' && (
          <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-semibold text-slate-600 sticky top-0">
                  <th className="py-3 px-4">Timestamp</th>
                  <th className="py-3 px-4">Actor</th>
                  <th className="py-3 px-4">Action</th>
                  <th className="py-3 px-4">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-xs">
                {filteredActivities.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-10 px-4 text-center text-sm text-slate-500">
                      No audited activity logs match your search.
                    </td>
                  </tr>
                ) : (
                  filteredActivities.map((act) => (
                    <tr key={act.id} className="hover:bg-slate-50/70">
                      <td className="py-3 px-4 font-mono text-slate-500 whitespace-nowrap tabular-nums">
                        {new Date(act.createdAt).toLocaleString()}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium text-slate-900">{act.userName}</div>
                        <div className="text-slate-500">{act.userEmail}</div>
                      </td>
                      <td className="py-3 px-4 font-mono font-semibold text-slate-800 whitespace-nowrap">
                        {act.action}
                      </td>
                      <td className="py-3 px-4 text-slate-700 break-words">{act.details}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Carrier Gateway Config Tab */}
        {activeTab === 'gateway' && overview && (
          <div className="p-6 space-y-5">
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-slate-900">
                Direct Rwandan Cellular SMS &amp; Voice Gateway (+250)
              </h3>
              <p className="text-sm text-slate-600">
                To send SMS directly from this app into a recipient&apos;s physical phone SMS inbox
                (MTN Rwanda 078/079 &amp; Airtel Rwanda 072/073), add credentials for any one of the
                four supported carrier gateways in your environment Secrets panel. Without carrier
                secrets, dispatches route to the built-in Phone &amp; Tablet Receiver.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="border border-emerald-200 bg-emerald-50/40 rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    Pindo SMS (Rwanda)
                  </span>
                  <span
                    className={`text-xs font-semibold whitespace-nowrap ${
                      overview.gateway.pindoConfigured ? 'text-emerald-700' : 'text-slate-500'
                    }`}
                  >
                    {overview.gateway.pindoConfigured ? 'Configured · Live' : 'Optional · Unset'}
                  </span>
                </div>
                <p className="text-xs text-slate-600 font-mono">
                  Env: PINDO_API_TOKEN, PINDO_SENDER_ID
                </p>
              </div>

              <div className="border border-slate-200 rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    Africa&apos;s Talking (Rwanda)
                  </span>
                  <span
                    className={`text-xs font-semibold whitespace-nowrap ${
                      overview.gateway.africasTalkingConfigured
                        ? 'text-emerald-700'
                        : 'text-slate-500'
                    }`}
                  >
                    {overview.gateway.africasTalkingConfigured
                      ? 'Configured · Live'
                      : 'Optional · Unset'}
                  </span>
                </div>
                <p className="text-xs text-slate-600 font-mono">
                  Env: AT_USERNAME, AT_API_KEY, AT_SENDER_ID, AT_VOICE_NUMBER
                </p>
              </div>

              <div className="border border-slate-200 rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">Twilio SMS &amp; Voice</span>
                  <span
                    className={`text-xs font-semibold whitespace-nowrap ${
                      overview.gateway.twilioConfigured ? 'text-emerald-700' : 'text-slate-500'
                    }`}
                  >
                    {overview.gateway.twilioConfigured ? 'Configured · Live' : 'Optional · Unset'}
                  </span>
                </div>
                <p className="text-xs text-slate-600 font-mono">
                  Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
                </p>
              </div>

              <div className="border border-slate-200 rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    Android / HTTP SIM Gateway
                  </span>
                  <span
                    className={`text-xs font-semibold whitespace-nowrap ${
                      overview.gateway.httpGatewayConfigured
                        ? 'text-emerald-700'
                        : 'text-slate-500'
                    }`}
                  >
                    {overview.gateway.httpGatewayConfigured
                      ? 'Configured · Live'
                      : 'Optional · Unset'}
                  </span>
                </div>
                <p className="text-xs text-slate-600 font-mono">
                  Env: SMS_GATEWAY_URL, SMS_GATEWAY_TOKEN
                </p>
              </div>

              <div className="border border-slate-200 bg-slate-50 rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    In-App Phone Relay (+250)
                  </span>
                  <span className="text-xs font-semibold text-emerald-700 whitespace-nowrap">
                    {overview.gateway.activeProvider === 'local_relay'
                      ? 'Active Fallback'
                      : 'Fallback Ready'}
                  </span>
                </div>
                <p className="text-xs text-slate-600">
                  Real-time in-app SMS &amp; voice receiver when external carrier secrets are unset.
                </p>
              </div>
            </div>

            {(() => {
              const origin = (
                typeof window !== 'undefined' && window.location.origin
                  ? window.location.origin
                  : overview.gateway.appUrl
              ).replace(/\/$/, '');
              const latestVoiceMsg = messages.find((m) => Boolean(m.audioUrl));
              const atCallbackUrl = `${origin}/api/gateway/voice-xml?provider=africas_talking`;
              const twilioCallbackUrl = latestVoiceMsg
                ? `${origin}/api/gateway/voice-xml/${latestVoiceMsg.id}`
                : `${origin}/api/gateway/voice-xml`;

              return (
                <div className="border border-slate-200 rounded-lg p-4 bg-slate-50 space-y-4">
                  <div className="space-y-1">
                    <p className="text-xs font-semibold text-slate-900">
                      Telecom Webhook URLs (Optional — For External Live Carrier Keys Only)
                    </p>
                    <p className="text-xs text-slate-600 leading-relaxed">
                      These endpoints return machine-readable Voice XML / TwiML instructions read by{' '}
                      <strong>Africa&apos;s Talking</strong> or <strong>Twilio</strong> servers
                      when placing cellular voice calls (web browsers display raw XML without styling
                      because it is a server-to-server telecom protocol). You do not need these when
                      using the built-in Feature-Phone Relay.
                    </p>
                  </div>

                  <div className="space-y-3">
                    <div className="bg-white border border-slate-200 rounded-md p-3 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-800">
                          Africa&apos;s Talking Voice Callback (POST / GET)
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => void copyEndpoint('at', atCallbackUrl)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded whitespace-nowrap cursor-pointer"
                          >
                            <Copy className="w-3.5 h-3.5" />
                            {copiedKey === 'at' ? 'Copied' : 'Copy'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void previewVoiceXml(atCallbackUrl)}
                            className="px-2.5 py-1 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 rounded whitespace-nowrap cursor-pointer"
                          >
                            Preview XML
                          </button>
                        </div>
                      </div>
                      <p className="text-xs font-mono text-slate-600 break-all">{atCallbackUrl}</p>
                    </div>

                    <div className="bg-white border border-slate-200 rounded-md p-3 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-800">
                          Twilio TwiML Playback Callback{' '}
                          {latestVoiceMsg ? '(Latest Voice Message)' : '(Auto-Latest)'}
                        </span>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => void copyEndpoint('twilio', twilioCallbackUrl)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded whitespace-nowrap cursor-pointer"
                          >
                            <Copy className="w-3.5 h-3.5" />
                            {copiedKey === 'twilio' ? 'Copied' : 'Copy'}
                          </button>
                          <button
                            type="button"
                            onClick={() => void previewVoiceXml(twilioCallbackUrl)}
                            className="px-2.5 py-1 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 rounded whitespace-nowrap cursor-pointer"
                          >
                            Preview XML
                          </button>
                        </div>
                      </div>
                      <p className="text-xs font-mono text-slate-600 break-all">
                        {twilioCallbackUrl}
                      </p>
                    </div>
                  </div>

                  {voiceXmlPreview && (
                    <div className="bg-slate-900 text-slate-100 rounded-md p-3 space-y-2.5">
                      <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                        <span className="font-mono truncate">{voiceXmlPreview.url}</span>
                        <button
                          type="button"
                          onClick={() => setVoiceXmlPreview(null)}
                          className="text-slate-300 hover:text-white shrink-0 cursor-pointer"
                        >
                          Close
                        </button>
                      </div>
                      <pre className="text-xs font-mono text-emerald-300 whitespace-pre-wrap break-all overflow-x-auto">
                        {voiceXmlPreview.loading ? 'Fetching XML response...' : voiceXmlPreview.xml}
                      </pre>
                      {latestVoiceMsg?.audioUrl && (
                        <div className="pt-2 border-t border-slate-800 flex flex-wrap items-center gap-3">
                          <span className="text-xs text-slate-300">Referenced Audio:</span>
                          <audio controls src={latestVoiceMsg.audioUrl} className="h-8 max-w-sm" />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Confirmation Modal (No window.confirm) */}
      {pendingConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4"
        >
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6 space-y-4 shadow-lg">
            <h3 className="text-base font-semibold text-slate-900">{pendingConfirm.title}</h3>
            <p className="text-sm text-slate-600">{pendingConfirm.description}</p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setPendingConfirm(null)}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const action = pendingConfirm.onConfirm;
                  setPendingConfirm(null);
                  void action();
                }}
                className={`px-4 py-2 text-sm font-semibold text-white rounded-lg ${
                  pendingConfirm.danger
                    ? 'bg-red-700 hover:bg-red-800'
                    : 'bg-teal-700 hover:bg-teal-800'
                }`}
              >
                {pendingConfirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
