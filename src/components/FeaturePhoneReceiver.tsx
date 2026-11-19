import React, { useEffect, useRef, useState } from 'react';
import {
  Bell,
  BellOff,
  Copy,
  PhoneCall,
  PhoneOff,
  RefreshCw,
  Smartphone,
  Tablet,
  Volume2,
  Wifi,
} from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import { getShareableOrigin, isPrivatePreviewHost, parseRwandaPhone } from '../lib/rwandaPhone.ts';
import type { CallRecord, MessageRecord, ReceiverDeviceMode } from '../types.ts';
import { LiveCallModal, type ActiveCallSession } from './LiveCallModal.tsx';

export type { ReceiverDeviceMode };

interface FeaturePhoneReceiverProps {
  initialPhone?: string;
  initialDevice?: ReceiverDeviceMode;
  onStartCall?: (phoneE164: string, device?: ReceiverDeviceMode) => void;
  onAnswerLiveCall?: (call: CallRecord, offer: RTCSessionDescriptionInit | null) => void;
}

interface RecentNumber {
  phone: string;
  carrier: string;
  count: number;
  latestAt: string;
}

function playIncomingChime() {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const tones = [587.33, 880];
    tones.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.14);
      gain.gain.setValueAtTime(0.001, now + idx * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.12, now + idx * 0.14 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.14 + 0.24);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.14);
      osc.stop(now + idx * 0.14 + 0.26);
    });
    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 800);
  } catch {
    // AudioContext may require prior user gesture
  }
}

export const FeaturePhoneReceiver: React.FC<FeaturePhoneReceiverProps> = ({
  initialPhone = '',
  initialDevice,
  onStartCall,
  onAnswerLiveCall,
}) => {
  const [deviceMode, setDeviceMode] = useState<ReceiverDeviceMode>(() => {
    if (initialDevice) return initialDevice;
    if (typeof window !== 'undefined' && window.innerWidth >= 768 && window.innerWidth <= 1180) {
      return 'tablet';
    }
    return 'feature';
  });
  const [soundEnabled, setSoundEnabled] = useState(true);
  const soundEnabledRef = useRef(true);
  soundEnabledRef.current = soundEnabled;

  const [phoneInput, setPhoneInput] = useState(initialPhone || '+250 788 452 910');
  const [activePhone, setActivePhone] = useState<string>(() => {
    if (initialPhone) {
      const parsed = parseRwandaPhone(initialPhone);
      if (parsed.valid) return parsed.e164;
    }
    return '+250788452910';
  });
  const [carrierName, setCarrierName] = useState<string>('MTN Rwanda');
  const [messages, setMessages] = useState<MessageRecord[]>([]);
  const [recentNumbers, setRecentNumbers] = useState<RecentNumber[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamConnected, setStreamConnected] = useState(false);
  const [copiedHandsetLink, setCopiedHandsetLink] = useState(false);
  const hasAutoSelectedRef = useRef(Boolean(initialPhone));

  // Incoming voice call state on the handset / tablet
  const [ringingCall, setRingingCall] = useState<MessageRecord | null>(null);
  const [answeredCall, setAnsweredCall] = useState<MessageRecord | null>(null);
  const [selectedSms, setSelectedSms] = useState<MessageRecord | null>(null);
  const [incomingLiveCall, setIncomingLiveCall] = useState<{
    call: CallRecord;
    offer: RTCSessionDescriptionInit | null;
  } | null>(null);
  const [localCallModal, setLocalCallModal] = useState<ActiveCallSession | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (initialDevice) {
      setDeviceMode(initialDevice);
    }
  }, [initialDevice]);

  useEffect(() => {
    if (initialPhone) {
      const parsed = parseRwandaPhone(initialPhone);
      if (parsed.valid) {
        hasAutoSelectedRef.current = true;
        setPhoneInput(parsed.formatted);
        setSelectedSms(null);
        setRingingCall(null);
        setAnsweredCall(null);
        setActivePhone(parsed.e164);
      }
    }
  }, [initialPhone]);

  async function fetchRecentNumbers(allowAutoSelect = false) {
    try {
      const res = await apiRequest<{ numbers: RecentNumber[] }>('/api/receiver/recent-numbers');
      setRecentNumbers(res.numbers);
      if (allowAutoSelect && !hasAutoSelectedRef.current && res.numbers.length > 0) {
        hasAutoSelectedRef.current = true;
        const latest = res.numbers[0];
        const parsed = parseRwandaPhone(latest.phone);
        setPhoneInput(parsed.valid ? parsed.formatted : latest.phone);
        setSelectedSms(null);
        setActivePhone(latest.phone);
      }
    } catch {
      // Ignore silent background load
    }
  }

  async function loadMessagesForPhone(phoneE164: string, selectLatestIfEmpty = true) {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<{
        phone: string;
        formatted: string;
        carrier: string;
        messages: MessageRecord[];
        activeCall?: {
          call: CallRecord;
          offer: RTCSessionDescriptionInit | null;
        } | null;
      }>(`/api/receiver/messages?phone=${encodeURIComponent(phoneE164)}`);
      setCarrierName(res.carrier);
      setMessages(res.messages);
      if (res.activeCall) {
        setIncomingLiveCall((prev) =>
          prev?.call.id === res.activeCall?.call.id ? prev : res.activeCall || null
        );
      } else {
        setIncomingLiveCall(null);
      }
      if (selectLatestIfEmpty && res.messages.length > 0) {
        setSelectedSms((prev) =>
          prev && res.messages.some((m) => m.id === prev.id) ? prev : res.messages[0]
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load handset inbox.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchRecentNumbers(true);
  }, []);

  useEffect(() => {
    if (!activePhone) return;
    void loadMessagesForPhone(activePhone, true);

    const es = new EventSource(`/api/receiver/stream?phone=${encodeURIComponent(activePhone)}`);
    es.addEventListener('connected', () => {
      setStreamConnected(true);
    });
    es.addEventListener('new_message', (ev) => {
      try {
        const incoming = JSON.parse((ev as MessageEvent<string>).data) as MessageRecord;
        setMessages((prev) => [incoming, ...prev.filter((m) => m.id !== incoming.id)]);
        setSelectedSms(incoming);
        if (soundEnabledRef.current) {
          playIncomingChime();
        }
        if (incoming.audioUrl) {
          setAnsweredCall(null);
          setRingingCall(incoming);
        }
        void fetchRecentNumbers();
      } catch {
        // Ignore parse error
      }
    });
    es.addEventListener('message_updated', (ev) => {
      try {
        const updated = JSON.parse((ev as MessageEvent<string>).data) as MessageRecord;
        setMessages((prev) =>
          updated.status === 'failed' || updated.status === 'cancelled'
            ? prev.filter((m) => m.id !== updated.id)
            : prev.map((m) => (m.id === updated.id ? updated : m))
        );
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
        if (soundEnabledRef.current) {
          playIncomingChime();
        }
        setIncomingLiveCall(payload);
      } catch {
        // Ignore parse error
      }
    });
    es.addEventListener('call_ended', (ev) => {
      try {
        const payload = JSON.parse((ev as MessageEvent<string>).data) as { call: CallRecord };
        setIncomingLiveCall((prev) => (prev?.call.id === payload.call.id ? null : prev));
      } catch {
        // Ignore parse error
      }
    });
    es.onerror = () => {
      setStreamConnected(false);
    };

    const pollInterval = window.setInterval(() => {
      void loadMessagesForPhone(activePhone, true);
      void fetchRecentNumbers();
    }, 5000);

    return () => {
      setStreamConnected(false);
      window.clearInterval(pollInterval);
      es.close();
    };
  }, [activePhone]);

  function handleConnectPhone(e: React.FormEvent) {
    e.preventDefault();
    const parsed = parseRwandaPhone(phoneInput);
    if (!parsed.valid) {
      setError(parsed.error || 'Enter a valid Rwandan mobile number.');
      return;
    }
    setError(null);
    setSelectedSms(null);
    setRingingCall(null);
    setAnsweredCall(null);
    setPhoneInput(parsed.formatted);
    setActivePhone(parsed.e164);
  }

  function handleAnswerCall(msg: MessageRecord) {
    setRingingCall(null);
    setAnsweredCall(msg);
    window.setTimeout(() => {
      if (audioPlayerRef.current) {
        void audioPlayerRef.current.play().catch(() => {
          // Autoplay may be blocked if not direct gesture; controls remain available
        });
      }
    }, 60);
  }

  function handleCopyReceiverLink(targetDevice: ReceiverDeviceMode = deviceMode) {
    const url = new URL(getShareableOrigin());
    url.searchParams.set('receiver', activePhone);
    if (targetDevice !== 'feature') {
      url.searchParams.set('device', targetDevice);
    }
    void navigator.clipboard?.writeText(url.toString());
    setCopiedHandsetLink(true);
    setTimeout(() => setCopiedHandsetLink(false), 2000);
  }

  const parsedActive = parseRwandaPhone(activePhone);

  return (
    <div className="space-y-6">
      {/* Recipient Number & Device Mode Bar */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Rwandan Phone &amp; Tablet Live Receiver
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Connect any +250 number to receive live SMS text and voice audio on button phones,
              smartphones, or Wi-Fi tablets without needing a cellular SIM card
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {/* Device View Segmented Switch */}
            <div
              role="group"
              aria-label="Receiver device layout"
              className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg"
            >
              {(
                [
                  { id: 'feature', label: 'Feature Phone', Icon: PhoneCall },
                  { id: 'smartphone', label: 'Smartphone', Icon: Smartphone },
                  { id: 'tablet', label: 'Tablet', Icon: Tablet },
                ] as const
              ).map((opt) => {
                const Icon = opt.Icon;
                const active = deviceMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setDeviceMode(opt.id)}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      active
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                    {opt.label}
                  </button>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => setSoundEnabled((v) => !v)}
              title={soundEnabled ? 'Mute incoming sound chime' : 'Enable incoming sound chime'}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                soundEnabled
                  ? 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                  : 'bg-slate-100 text-slate-500 border-slate-200'
              }`}
            >
              {soundEnabled ? <Bell className="w-3.5 h-3.5 text-teal-700" /> : <BellOff className="w-3.5 h-3.5" />}
              {soundEnabled ? 'Sound On' : 'Muted'}
            </button>

            <div className="flex items-center gap-2 text-xs text-slate-600 tabular-nums whitespace-nowrap">
              {streamConnected && (
                <span
                  className="inline-block w-2 h-2 rounded-full bg-emerald-600"
                  aria-hidden="true"
                />
              )}
              <span>{streamConnected ? 'Live Signal Connected' : 'Connecting Signal...'}</span>
            </div>
          </div>
        </div>

        <form onSubmit={handleConnectPhone} className="flex flex-wrap items-center gap-3">
          <input
            type="tel"
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            placeholder="+250 788 452 910"
            className="flex-1 min-w-[220px] min-h-[42px] px-3.5 py-2 text-sm font-mono bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600"
          />
          <button
            type="submit"
            className="min-h-[42px] px-4 py-2 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Listen on This Number
          </button>
          <button
            type="button"
            onClick={() => void loadMessagesForPhone(activePhone)}
            className="min-h-[42px] inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => handleCopyReceiverLink(deviceMode)}
            className="min-h-[42px] inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Copy className="w-4 h-4" />
            {copiedHandsetLink
              ? 'Link Copied'
              : deviceMode === 'tablet'
                ? 'Copy Tablet Link'
                : deviceMode === 'smartphone'
                  ? 'Copy Smartphone Link'
                  : 'Share Inbox Link'}
          </button>
          {onStartCall && (
            <button
              type="button"
              onClick={() => onStartCall(activePhone, deviceMode)}
              className="min-h-[42px] inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold text-white bg-emerald-700 hover:bg-emerald-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <PhoneCall className="w-4 h-4" />
              Call Live
            </button>
          )}
          <a
            href={`tel:${activePhone}`}
            className="min-h-[42px] inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            <PhoneCall className="w-4 h-4 text-emerald-700" />
            Call via SIM
          </a>
        </form>

        {incomingLiveCall && (
          <div className="p-4 bg-teal-950 text-white rounded-xl flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-emerald-600/30 border border-emerald-400/50 flex items-center justify-center shrink-0">
                <PhoneCall className="w-5 h-5 text-emerald-300" />
              </div>
              <div>
                <p className="text-xs font-mono text-emerald-300">INCOMING LIVE VOICE CALL</p>
                <p className="text-sm font-semibold">
                  {incomingLiveCall.call.callerName} ·{' '}
                  <span className="font-mono">{incomingLiveCall.call.callerPhone}</span>
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  const target = incomingLiveCall;
                  setIncomingLiveCall(null);
                  if (onAnswerLiveCall) {
                    onAnswerLiveCall(target.call, target.offer);
                  } else {
                    setLocalCallModal({
                      direction: 'incoming',
                      call: target.call,
                      offer: target.offer,
                    });
                  }
                }}
                className="min-h-[42px] px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-500 rounded-lg cursor-pointer whitespace-nowrap"
              >
                Answer Live Call
              </button>
              <button
                type="button"
                onClick={() => {
                  const id = incomingLiveCall.call.id;
                  setIncomingLiveCall(null);
                  void apiRequest(`/api/calls/${id}/end`, {
                    method: 'POST',
                    body: JSON.stringify({ reason: 'declined' }),
                  }).catch(() => {});
                }}
                className="min-h-[42px] px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg cursor-pointer whitespace-nowrap"
              >
                Decline
              </button>
            </div>
          </div>
        )}

        {copiedHandsetLink && isPrivatePreviewHost() && (
          <p className="text-xs text-slate-600">
            Copied preview link for this signed-in browser. To open on a separate phone or tablet without &ldquo;Page not found&rdquo;, publish/share the app first and copy the link from the shared URL.
          </p>
        )}

        {error && (
          <div role="alert" className="p-2.5 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg">
            {error}
          </div>
        )}

        {recentNumbers.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="text-xs text-slate-500">Active recipient phones:</span>
            {recentNumbers.map((item) => (
              <button
                key={item.phone}
                type="button"
                onClick={() => {
                  const p = parseRwandaPhone(item.phone);
                  setPhoneInput(p.formatted);
                  setSelectedSms(null);
                  setActivePhone(item.phone);
                }}
                className={`px-2.5 py-1.5 text-xs font-mono rounded-md transition-colors whitespace-nowrap tabular-nums cursor-pointer ${
                  activePhone === item.phone
                    ? 'bg-teal-700 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {item.phone} ({item.count})
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Tablet Widescreen Split Inbox vs Handset + Inbox Split */}
      {deviceMode === 'tablet' ? (
        <div className="bg-slate-900 rounded-[1.75rem] p-3.5 md:p-5 border-4 border-slate-800 shadow-sm space-y-3">
          {/* Tablet Status Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 px-2 text-xs font-mono text-slate-300 tabular-nums">
            <div className="flex items-center gap-2">
              <Tablet className="w-4 h-4 text-teal-400" aria-hidden="true" />
              <span className="font-semibold text-white">KigaliRelay Tablet Inbox</span>
              <span aria-hidden="true">·</span>
              <span>{parsedActive.valid ? parsedActive.formatted : activePhone}</span>
            </div>
            <div className="flex items-center gap-3 text-slate-400">
              <span className="inline-flex items-center gap-1">
                <Wifi className="w-3.5 h-3.5 text-emerald-400" aria-hidden="true" />
                Wi-Fi / {carrierName}
              </span>
              <span aria-hidden="true">·</span>
              <span>{streamConnected ? 'Live Sync On' : 'Syncing...'}</span>
            </div>
          </div>

          {/* Tablet Screen Canvas */}
          <div className="bg-white rounded-2xl overflow-hidden border border-slate-700/50 grid grid-cols-1 md:grid-cols-12 min-h-[480px]">
            {/* Left Tablet Thread List */}
            <div className="md:col-span-5 border-b md:border-b-0 md:border-r border-slate-200 flex flex-col">
              <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-2 bg-slate-50">
                <div>
                  <h3 className="text-sm font-semibold text-slate-900">Messages</h3>
                  <p className="text-xs text-slate-500 tabular-nums">
                    {messages.length} {messages.length === 1 ? 'item' : 'items'} for{' '}
                    {parsedActive.valid ? parsedActive.local : activePhone}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void loadMessagesForPhone(activePhone)}
                  className="p-2 text-slate-600 hover:text-slate-900 hover:bg-slate-200/70 rounded-lg cursor-pointer"
                  aria-label="Refresh tablet messages"
                >
                  <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {loading && messages.length === 0 ? (
                <div className="flex-1 p-8 flex items-center justify-center text-xs text-slate-500">
                  Loading tablet inbox...
                </div>
              ) : messages.length === 0 ? (
                <div className="flex-1 p-6 flex flex-col items-center justify-center text-center space-y-3">
                  <Tablet className="w-7 h-7 text-slate-300" />
                  <p className="text-sm font-medium text-slate-900">No messages on this tablet yet</p>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    Any SMS or voice message sent to{' '}
                    <span className="font-mono text-slate-700">
                      {parsedActive.formatted || activePhone}
                    </span>{' '}
                    appears here live over Wi-Fi or cellular data.
                  </p>
                  {recentNumbers.length > 0 && (
                    <div className="pt-1 flex flex-wrap items-center justify-center gap-2">
                      {recentNumbers.slice(0, 3).map((item) => (
                        <button
                          key={item.phone}
                          type="button"
                          onClick={() => {
                            hasAutoSelectedRef.current = true;
                            const p = parseRwandaPhone(item.phone);
                            setPhoneInput(p.valid ? p.formatted : item.phone);
                            setSelectedSms(null);
                            setActivePhone(item.phone);
                          }}
                          className="px-3 py-1.5 text-xs font-mono font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md whitespace-nowrap cursor-pointer"
                        >
                          Open {item.phone} ({item.count})
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex-1 divide-y divide-slate-200 max-h-[460px] overflow-y-auto">
                  {messages.map((msg) => {
                    const isSelected = (answeredCall?.id || selectedSms?.id) === msg.id;
                    return (
                      <button
                        key={msg.id}
                        type="button"
                        onClick={() => {
                          setAnsweredCall(null);
                          setRingingCall(null);
                          setSelectedSms(msg);
                        }}
                        className={`w-full text-left p-4 transition-colors space-y-1.5 cursor-pointer ${
                          isSelected ? 'bg-teal-50/80' : 'hover:bg-slate-50'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-semibold text-slate-900 truncate">
                            {msg.senderName}
                          </span>
                          <span className="font-mono text-slate-500 tabular-nums shrink-0">
                            {new Date(msg.createdAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-slate-500 tabular-nums">
                          <span className="font-mono">{msg.senderPhone}</span>
                          <span aria-hidden="true">·</span>
                          <span>
                            {msg.mode === 'both'
                              ? 'SMS + Voice'
                              : msg.mode === 'sms'
                                ? 'Text SMS'
                                : 'Voice Note'}
                          </span>
                        </div>
                        <p className="text-xs text-slate-700 line-clamp-2">
                          {msg.textBody || `Voice recording (${msg.audioDurationSec}s)`}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Right Tablet Detail & Audio Playback Pane */}
            <div className="md:col-span-7 p-6 flex flex-col justify-between space-y-5 bg-white">
              {ringingCall ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center space-y-5 p-6 bg-teal-950 text-white rounded-xl">
                  <PhoneCall className="w-10 h-10 text-emerald-300" />
                  <div className="space-y-1">
                    <p className="text-xs font-mono text-emerald-300">INCOMING TABLET VOICE CALL</p>
                    <h4 className="text-xl font-semibold">{ringingCall.senderName}</h4>
                    <p className="text-sm font-mono text-teal-200">{ringingCall.senderPhone}</p>
                    <p className="text-xs text-teal-300 pt-1">
                      Voice audio ({ringingCall.audioDurationSec}s) ready to play
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => handleAnswerCall(ringingCall)}
                      className="min-h-[44px] px-6 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold text-white cursor-pointer"
                    >
                      Answer &amp; Play Audio
                    </button>
                    <button
                      type="button"
                      onClick={() => setRingingCall(null)}
                      className="min-h-[44px] px-5 py-2.5 rounded-lg bg-red-700 hover:bg-red-600 text-sm font-semibold text-white cursor-pointer"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ) : answeredCall || selectedSms ? (
                (() => {
                  const current = answeredCall || selectedSms!;
                  return (
                    <div className="flex-1 flex flex-col justify-between space-y-5">
                      <div className="space-y-4">
                        <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b border-slate-200">
                          <div>
                            <h4 className="text-base font-semibold text-slate-900">
                              {current.senderName}
                            </h4>
                            <p className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">
                              {current.senderPhone} · To {current.recipientPhone} ({current.recipientCarrier})
                            </p>
                          </div>
                          <div className="text-right text-xs text-slate-500 font-mono tabular-nums">
                            <p>
                              {new Date(current.createdAt).toLocaleString([], {
                                month: 'short',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </p>
                            {current.ivrCode && <p className="mt-0.5">IVR *180*{current.ivrCode}#</p>}
                          </div>
                        </div>

                        {current.textBody ? (
                          <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl">
                            <p className="text-base text-slate-900 leading-relaxed whitespace-pre-wrap">
                              {current.textBody}
                            </p>
                          </div>
                        ) : (
                          <p className="text-sm text-slate-500">
                            Voice-only message received for your tablet.
                          </p>
                        )}

                        {current.audioUrl && (
                          <div className="p-4 bg-teal-50/70 border border-teal-200 rounded-xl space-y-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-teal-900">
                                <Volume2 className="w-4 h-4 text-teal-700" />
                                Voice Message ({current.audioDurationSec}s)
                              </span>
                              <button
                                type="button"
                                onClick={() => handleAnswerCall(current)}
                                className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-lg cursor-pointer"
                              >
                                <PhoneCall className="w-3.5 h-3.5" />
                                Play Now
                              </button>
                            </div>
                            <audio
                              ref={audioPlayerRef}
                              controls
                              src={current.audioUrl}
                              className="w-full h-11"
                            />
                          </div>
                        )}
                      </div>

                      <div className="pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 font-mono tabular-nums">
                        <span>Ref: {current.gatewayReference}</span>
                        <span>{current.deliveryNote}</span>
                      </div>
                    </div>
                  );
                })()
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center space-y-2 text-slate-500">
                  <Tablet className="w-9 h-9 text-slate-300" />
                  <p className="text-sm font-medium text-slate-900">Tablet Reader Ready</p>
                  <p className="text-xs max-w-sm leading-relaxed">
                    Select any message on the left to read the SMS text or listen to the voice
                    recording directly on your tablet speakers.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
          {/* Handset Display (Feature Phone or Smartphone) */}
          <div className="md:col-span-5 bg-white border border-slate-200 rounded-xl p-6">
            {deviceMode === 'smartphone' ? (
              <div className="max-w-[330px] mx-auto bg-slate-950 rounded-[2.25rem] p-3.5 border-[5px] border-slate-800 shadow-sm space-y-3">
                <div className="flex items-center justify-between text-[11px] font-mono text-slate-300 px-2 pt-1 tabular-nums">
                  <span>{carrierName} · 4G</span>
                  <span>{parsedActive.valid ? parsedActive.local : activePhone}</span>
                </div>

                <div className="bg-white rounded-[1.5rem] p-4 min-h-[380px] flex flex-col justify-between space-y-4">
                  {ringingCall ? (
                    <div className="flex-1 flex flex-col justify-between bg-slate-900 text-white rounded-xl p-4 space-y-4">
                      <div className="space-y-1.5 text-center pt-4">
                        <PhoneCall className="w-9 h-9 text-emerald-400 mx-auto" />
                        <p className="text-xs font-mono text-emerald-400">INCOMING SMARTPHONE CALL</p>
                        <p className="text-base font-semibold">{ringingCall.senderName}</p>
                        <p className="text-xs font-mono text-slate-300">{ringingCall.senderPhone}</p>
                        <p className="text-xs text-slate-400 pt-1">
                          Voice recording ({ringingCall.audioDurationSec}s)
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => handleAnswerCall(ringingCall)}
                          className="min-h-[44px] py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white cursor-pointer"
                        >
                          Answer
                        </button>
                        <button
                          type="button"
                          onClick={() => setRingingCall(null)}
                          className="min-h-[44px] py-2 px-3 rounded-lg bg-red-600 hover:bg-red-500 text-xs font-semibold text-white cursor-pointer"
                        >
                          Decline
                        </button>
                      </div>
                    </div>
                  ) : answeredCall ? (
                    <div className="flex-1 flex flex-col justify-between space-y-4">
                      <div className="space-y-3">
                        <div className="flex items-center justify-between text-xs font-mono text-teal-800 border-b border-slate-200 pb-2">
                          <span>CONNECTED</span>
                          <span>{answeredCall.audioDurationSec}s</span>
                        </div>
                        <p className="text-sm font-semibold text-slate-900">
                          {answeredCall.senderName}
                        </p>
                        {answeredCall.audioUrl && (
                          <audio
                            ref={audioPlayerRef}
                            controls
                            src={answeredCall.audioUrl}
                            className="w-full h-10"
                          />
                        )}
                        {answeredCall.textBody && (
                          <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">
                            {answeredCall.textBody}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setAnsweredCall(null)}
                        className="min-h-[44px] w-full py-2 rounded-lg bg-red-600 hover:bg-red-700 text-xs font-semibold text-white inline-flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <PhoneOff className="w-3.5 h-3.5" />
                        End Audio
                      </button>
                    </div>
                  ) : selectedSms ? (
                    <div className="flex-1 flex flex-col justify-between space-y-3">
                      <div className="space-y-2.5">
                        <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 border-b border-slate-200 pb-2">
                          <span>{selectedSms.senderPhone}</span>
                          <span>IVR *{selectedSms.ivrCode}#</span>
                        </div>
                        <p className="text-sm font-semibold text-slate-900">
                          {selectedSms.senderName}
                        </p>
                        {selectedSms.textBody ? (
                          <p className="text-sm leading-relaxed text-slate-800 break-words whitespace-pre-wrap">
                            {selectedSms.textBody}
                          </p>
                        ) : (
                          <p className="text-xs text-slate-500">Voice message received.</p>
                        )}
                      </div>
                      {selectedSms.audioUrl && (
                        <div className="space-y-2 pt-2 border-t border-slate-200">
                          <audio controls src={selectedSms.audioUrl} className="w-full h-10" />
                          <button
                            type="button"
                            onClick={() => handleAnswerCall(selectedSms)}
                            className="min-h-[42px] w-full py-2 px-3 rounded-lg bg-teal-700 hover:bg-teal-800 text-xs font-semibold text-white inline-flex items-center justify-center gap-1.5 cursor-pointer"
                          >
                            <Volume2 className="w-3.5 h-3.5" />
                            Listen in Call View ({selectedSms.audioDurationSec}s)
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-center space-y-2 text-slate-500">
                      <Smartphone className="w-8 h-8 text-slate-300" />
                      <p className="text-xs font-semibold text-slate-800">Smartphone Standby</p>
                      <p className="text-xs leading-relaxed">
                        Live SMS and voice recordings sent to{' '}
                        <span className="font-mono">{parsedActive.formatted || activePhone}</span>{' '}
                        appear here immediately.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="max-w-[310px] mx-auto bg-slate-900 rounded-3xl p-4 border-4 border-slate-800 shadow-sm space-y-3">
                <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 px-1">
                  <span>{carrierName}</span>
                  <span>{parsedActive.valid ? parsedActive.local : activePhone}</span>
                </div>

            <div className="bg-emerald-950/95 border border-emerald-800 rounded-xl p-3.5 min-h-[250px] flex flex-col justify-between text-emerald-50 space-y-3">
              {ringingCall ? (
                <div className="flex-1 flex flex-col justify-between space-y-4">
                  <div className="space-y-1 text-center pt-3">
                    <PhoneCall className="w-8 h-8 text-emerald-300 mx-auto" />
                    <p className="text-xs font-mono text-emerald-300">INCOMING VOICE CALL</p>
                    <p className="text-sm font-semibold text-white">{ringingCall.senderName}</p>
                    <p className="text-xs font-mono text-emerald-200">{ringingCall.senderPhone}</p>
                    <p className="text-[11px] text-emerald-300/80 pt-1">
                      Voice message ({ringingCall.audioDurationSec}s) ready
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => handleAnswerCall(ringingCall)}
                      className="py-2 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white cursor-pointer"
                    >
                      Answer
                    </button>
                    <button
                      type="button"
                      onClick={() => setRingingCall(null)}
                      className="py-2 px-3 rounded-lg bg-red-700 hover:bg-red-600 text-xs font-semibold text-white cursor-pointer"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ) : answeredCall ? (
                <div className="flex-1 flex flex-col justify-between space-y-3">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[11px] font-mono text-emerald-300 border-b border-emerald-800 pb-1.5">
                      <span>CALL CONNECTED</span>
                      <span>{answeredCall.audioDurationSec}s</span>
                    </div>
                    <p className="text-xs font-semibold text-white">
                      Playing audio from {answeredCall.senderName}
                    </p>
                    {answeredCall.audioUrl && (
                      <audio
                        ref={audioPlayerRef}
                        controls
                        src={answeredCall.audioUrl}
                        className="w-full h-9"
                      />
                    )}
                    {answeredCall.textBody && (
                      <p className="text-xs text-emerald-100/90 pt-1">{answeredCall.textBody}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setAnsweredCall(null)}
                    className="w-full py-2 rounded-lg bg-red-700 hover:bg-red-600 text-xs font-semibold text-white inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <PhoneOff className="w-3.5 h-3.5" />
                    End Call
                  </button>
                </div>
              ) : selectedSms ? (
                <div className="flex-1 flex flex-col justify-between space-y-3">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[11px] font-mono text-emerald-300 border-b border-emerald-800 pb-1.5">
                      <span>FROM: {selectedSms.senderPhone}</span>
                      <span>IVR *{selectedSms.ivrCode}#</span>
                    </div>
                    <p className="text-xs font-semibold text-emerald-200">
                      {selectedSms.senderName}
                    </p>
                    {selectedSms.textBody ? (
                      <p className="text-xs leading-relaxed text-white break-words">
                        {selectedSms.textBody}
                      </p>
                    ) : (
                      <p className="text-xs text-emerald-200/80">
                        Voice-only message received.
                      </p>
                    )}
                  </div>

                  {selectedSms.audioUrl && (
                    <button
                      type="button"
                      onClick={() => handleAnswerCall(selectedSms)}
                      className="w-full py-2 px-3 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-xs font-semibold text-white inline-flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <Volume2 className="w-3.5 h-3.5" />
                      Play Voice Audio ({selectedSms.audioDurationSec}s)
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center space-y-2 text-emerald-200/80">
                  <Smartphone className="w-7 h-7" />
                  <p className="text-xs font-medium">Handset Standby</p>
                  <p className="text-[11px]">
                    Send an SMS or voice call to {parsedActive.formatted || activePhone} to see it
                    arrive here immediately.
                  </p>
                </div>
              )}
            </div>

                <div className="grid grid-cols-3 gap-1.5 pt-1">
                  {['1', '2 ABC', '3 DEF', '4 GHI', '5 JKL', '6 MNO', '7 PQRS', '8 TUV', '9 WXYZ', '*', '0 +', '#'].map(
                    (keyLabel) => (
                      <div
                        key={keyLabel}
                        className="py-1.5 rounded bg-slate-800 text-center text-[10px] font-mono text-slate-300 select-none"
                      >
                        {keyLabel}
                      </div>
                    )
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Received SMS & Voice Call Log for this Rwandan Number */}
          <div className="md:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col min-h-[468px]">
          <div className="p-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 shrink-0">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Inbox for {parsedActive.formatted || activePhone}
              </h3>
              <p className="text-xs text-slate-500 tabular-nums mt-0.5">
                {messages.length} received {messages.length === 1 ? 'message' : 'messages'} ·{' '}
                {carrierName}
              </p>
            </div>
            <span className="text-xs font-mono text-slate-500 tabular-nums">
              {streamConnected ? 'Auto-sync active' : 'Manual refresh'}
            </span>
          </div>

          {loading && messages.length === 0 ? (
            <div className="flex-1 p-10 flex items-center justify-center text-sm text-slate-500">
              Checking inbox for {parsedActive.formatted || activePhone}...
            </div>
          ) : messages.length === 0 ? (
            <div className="flex-1 p-10 flex flex-col items-center justify-center text-center space-y-3">
              <Smartphone className="w-7 h-7 text-slate-300" />
              <p className="text-sm font-medium text-slate-900">
                No messages received on this number yet
              </p>
              <p className="text-xs text-slate-500 max-w-sm leading-relaxed">
                Compose and send a text SMS or voice recording to{' '}
                <span className="font-mono text-slate-700">
                  {parsedActive.formatted || activePhone}
                </span>{' '}
                and it will appear here and ring the handset on the left.
              </p>
              {recentNumbers.length > 0 && (
                <div className="pt-2 flex flex-wrap items-center justify-center gap-2">
                  {recentNumbers.slice(0, 4).map((item) => (
                    <button
                      key={item.phone}
                      type="button"
                      onClick={() => {
                        hasAutoSelectedRef.current = true;
                        const p = parseRwandaPhone(item.phone);
                        setPhoneInput(p.valid ? p.formatted : item.phone);
                        setSelectedSms(null);
                        setActivePhone(item.phone);
                      }}
                      className="px-3 py-1.5 text-xs font-mono font-medium text-teal-800 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-md whitespace-nowrap cursor-pointer"
                    >
                      Open {item.phone} ({item.count})
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex-1 divide-y divide-slate-200 max-h-[460px] overflow-y-auto">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  onClick={() => setSelectedSms(msg)}
                  className={`p-5 cursor-pointer transition-colors space-y-2.5 ${
                    selectedSms?.id === msg.id ? 'bg-teal-50/60' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 tabular-nums">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-slate-900">{msg.senderName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{msg.senderPhone}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {msg.mode === 'both'
                          ? 'SMS + Voice'
                          : msg.mode === 'sms'
                            ? 'SMS'
                            : 'Voice Call'}
                      </span>
                      {msg.audioUrl && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono text-slate-500">IVR *{msg.ivrCode}#</span>
                        </>
                      )}
                    </div>
                    <span className="font-mono text-slate-500">
                      {new Date(msg.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>

                  {msg.textBody && (
                    <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
                      {msg.textBody}
                    </p>
                  )}

                  {msg.audioUrl && (
                    <div className="flex flex-wrap items-center gap-3 pt-1">
                      <audio controls src={msg.audioUrl} className="h-9 max-w-sm w-full" />
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAnswerCall(msg);
                        }}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-teal-800 bg-teal-50 border border-teal-200 hover:bg-teal-100 rounded-md whitespace-nowrap cursor-pointer"
                      >
                        <PhoneCall className="w-3.5 h-3.5" />
                        Answer Voice Call
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      )}

      {localCallModal && (
        <LiveCallModal session={localCallModal} onClose={() => setLocalCallModal(null)} />
      )}
    </div>
  );
};
