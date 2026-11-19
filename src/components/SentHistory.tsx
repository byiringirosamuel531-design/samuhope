import React, { useMemo, useState } from 'react';
import {
  Ban,
  CheckCircle2,
  Clock,
  MessageCircle,
  PhoneCall,
  RefreshCw,
  Search,
  Smartphone,
  XCircle,
} from 'lucide-react';
import { buildSmartphoneDeliveryLinks } from '../lib/rwandaPhone.ts';
import type { MessageRecord, ReceiverDeviceMode } from '../types.ts';

interface SentHistoryProps {
  messages: MessageRecord[];
  loading: boolean;
  onRefresh: () => void;
  onInspectPhone: (phoneE164: string, device?: ReceiverDeviceMode) => void;
  onStartCall: (phoneE164: string, device?: ReceiverDeviceMode) => void;
}

type StatusFilter = 'all' | 'delivered' | 'pending' | 'failed';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getStatusVisual(status: MessageRecord['status']) {
  switch (status) {
    case 'delivered_gateway':
      return {
        label: 'Delivered (Gateway)',
        shortGroup: 'delivered' as const,
        Icon: CheckCircle2,
        containerClass: 'bg-emerald-50 text-emerald-800 border-emerald-200',
        iconClass: 'text-emerald-600',
        dotClass: 'bg-emerald-500',
      };
    case 'delivered_relay':
      return {
        label: 'Delivered (Relay)',
        shortGroup: 'delivered' as const,
        Icon: CheckCircle2,
        containerClass: 'bg-emerald-50 text-emerald-800 border-emerald-200',
        iconClass: 'text-emerald-600',
        dotClass: 'bg-emerald-500',
      };
    case 'queued':
      return {
        label: 'Pending (Queued)',
        shortGroup: 'pending' as const,
        Icon: Clock,
        containerClass: 'bg-amber-50 text-amber-800 border-amber-200',
        iconClass: 'text-amber-600',
        dotClass: 'bg-amber-500',
      };
    case 'cancelled':
      return {
        label: 'Cancelled',
        shortGroup: 'failed' as const,
        Icon: Ban,
        containerClass: 'bg-slate-100 text-slate-700 border-slate-300',
        iconClass: 'text-slate-500',
        dotClass: 'bg-slate-500',
      };
    case 'failed':
    default:
      return {
        label: 'Failed',
        shortGroup: 'failed' as const,
        Icon: XCircle,
        containerClass: 'bg-red-50 text-red-800 border-red-200',
        iconClass: 'text-red-600',
        dotClass: 'bg-red-500',
      };
  }
}

export const SentHistory: React.FC<SentHistoryProps> = ({
  messages,
  loading,
  onRefresh,
  onInspectPhone,
  onStartCall,
}) => {
  const [search, setSearch] = useState('');
  const [modeFilter, setModeFilter] = useState<'all' | 'sms' | 'voice' | 'both'>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const statusCounts = useMemo(() => {
    let delivered = 0;
    let pending = 0;
    let failed = 0;
    for (const m of messages) {
      const group = getStatusVisual(m.status).shortGroup;
      if (group === 'delivered') delivered += 1;
      else if (group === 'pending') pending += 1;
      else failed += 1;
    }
    return { delivered, pending, failed };
  }, [messages]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return messages.filter((m) => {
      if (modeFilter !== 'all' && m.mode !== modeFilter) return false;
      if (statusFilter !== 'all' && getStatusVisual(m.status).shortGroup !== statusFilter) {
        return false;
      }
      if (!q) return true;
      return (
        m.recipientPhone.toLowerCase().includes(q) ||
        m.recipientCarrier.toLowerCase().includes(q) ||
        m.textBody.toLowerCase().includes(q) ||
        m.gatewayReference.toLowerCase().includes(q) ||
        getStatusVisual(m.status).label.toLowerCase().includes(q)
      );
    });
  }, [messages, search, modeFilter, statusFilter]);

  return (
    <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
      <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Sent Messages &amp; Voice Notes</h2>
          <p className="text-xs text-slate-500 mt-0.5 tabular-nums flex flex-wrap items-center gap-1.5">
            <span>{messages.length} total dispatches</span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
              {statusCounts.delivered} delivered
            </span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
              {statusCounts.pending} pending
            </span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1 text-red-700 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
              {statusCounts.failed} failed/cancelled
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search +250 number or text..."
              className="pl-9 pr-3 py-1.5 text-sm bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
            />
          </div>

          <select
            aria-label="Filter by delivery status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
          >
            <option value="all">All Statuses</option>
            <option value="delivered">Delivered</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed / Cancelled</option>
          </select>

          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(['all', 'both', 'sms', 'voice'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setModeFilter(tab)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  modeFilter === tab
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {tab === 'all' ? 'All' : tab === 'both' ? 'SMS + Voice' : tab === 'sms' ? 'SMS' : 'Voice'}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onRefresh}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {loading && messages.length === 0 ? (
        <div className="p-8 text-center text-sm text-slate-500">Loading message history...</div>
      ) : filtered.length === 0 ? (
        <div className="p-10 text-center space-y-2">
          <p className="text-sm font-medium text-slate-900">No messages match your filter</p>
          <p className="text-xs text-slate-500">
            Compose a new SMS or voice message to reach any Rwandan mobile number.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-slate-200">
          {filtered.map((msg) => {
            const st = getStatusVisual(msg.status);
            const StatusIcon = st.Icon;
            return (
              <div key={msg.id} className="p-5 hover:bg-slate-50/70 transition-colors space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2.5 text-xs text-slate-600 tabular-nums">
                    <span
                      title={msg.deliveryNote || st.label}
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-xs font-medium whitespace-nowrap shrink-0 ${st.containerClass}`}
                    >
                      <StatusIcon className={`w-3.5 h-3.5 shrink-0 ${st.iconClass}`} aria-hidden="true" />
                      <span>{st.label}</span>
                    </span>
                    <span className="font-mono text-sm font-semibold text-slate-900">
                      {msg.recipientPhone}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{msg.recipientCarrier}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {msg.mode === 'both'
                        ? 'SMS + Voice Call'
                        : msg.mode === 'sms'
                          ? 'Text SMS'
                          : 'Voice Call'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{formatDate(msg.createdAt)}</span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onStartCall(msg.recipientPhone, 'smartphone')}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <PhoneCall className="w-3.5 h-3.5" />
                      Call Live
                    </button>
                    <a
                      href={`tel:${msg.recipientPhone}`}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-200 rounded-md transition-colors whitespace-nowrap shrink-0"
                    >
                      <PhoneCall className="w-3.5 h-3.5 text-emerald-700" />
                      SIM Call
                    </a>
                    <a
                      href={
                        buildSmartphoneDeliveryLinks({
                          recipientPhone: msg.recipientPhone,
                          textBody: msg.textBody,
                          hasAudio: Boolean(msg.audioUrl),
                          ivrCode: msg.ivrCode,
                        }).whatsappHref
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-md transition-colors whitespace-nowrap shrink-0"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                      WhatsApp
                    </a>
                    <button
                      type="button"
                      onClick={() => onInspectPhone(msg.recipientPhone)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Smartphone className="w-3.5 h-3.5" />
                      Open Live Inbox
                    </button>
                  </div>
                </div>

                {msg.textBody && (
                  <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                    {msg.textBody}
                  </p>
                )}

                {msg.audioUrl && (
                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <audio controls src={msg.audioUrl} className="h-9 max-w-md w-full" />
                    <span className="text-xs font-mono text-slate-500 tabular-nums">
                      Duration: {msg.audioDurationSec}s · IVR *180*{msg.ivrCode}#
                    </span>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${st.dotClass}`} aria-hidden="true" />
                  <span>
                    Ref: {msg.gatewayReference} · {msg.deliveryNote}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};