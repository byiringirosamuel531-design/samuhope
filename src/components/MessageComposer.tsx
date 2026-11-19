import React, { useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Copy,
  MessageCircle,
  PhoneCall,
  Send,
  Smartphone,
  Tablet,
  Volume2,
} from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import {
  buildSmartphoneDeliveryLinks,
  calculateSmsSegments,
  isPrivatePreviewHost,
  parseRwandaPhone,
} from '../lib/rwandaPhone.ts';
import type {
  DeliveryMode,
  GatewayStatusInfo,
  MessageRecord,
  ReceiverDeviceMode,
} from '../types.ts';
import { AudioRecorder, type RecordedAudioPayload } from './AudioRecorder.tsx';

interface MessageComposerProps {
  gateway: GatewayStatusInfo;
  onSent: (msg: MessageRecord) => void;
  onInspectPhone: (phoneE164: string, device?: ReceiverDeviceMode) => void;
  onStartCall: (phoneE164: string, device?: ReceiverDeviceMode) => void;
}

const QUICK_TEMPLATES = [
  {
    label: 'Umuganda Notice',
    text: 'Mwiriwe neza. Turabamenyesha ko igikorwa cy\'umuganda kizaba ejo saa 08:00 ku biro by\'umurenge. Murakoze.',
  },
  {
    label: 'Health Center Reminder',
    text: 'Muraho! Ikigo nderabuzima kirabibutsa gahunda yanyu yo kwisuzumisha ejo saa 09:30 za mu gitondo.',
  },
  {
    label: 'Family Check-in',
    text: 'Amakuru yanyu? Nabahamagaye ngo mbabaze uko mumeze, munyumve mu ijwi nabohereje.',
  },
];

export const MessageComposer: React.FC<MessageComposerProps> = ({
  gateway,
  onSent,
  onInspectPhone,
  onStartCall,
}) => {
  const [recipientInput, setRecipientInput] = useState('');
  const [mode, setMode] = useState<DeliveryMode>('both');
  const [recipientDevice, setRecipientDevice] = useState<ReceiverDeviceMode>('smartphone');
  const [textBody, setTextBody] = useState('');
  const [audio, setAudio] = useState<RecordedAudioPayload | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDispatched, setLastDispatched] = useState<MessageRecord | null>(null);
  const [copiedLinkType, setCopiedLinkType] = useState<'smartphone' | 'tablet' | null>(null);

  const parsedPhone = parseRwandaPhone(recipientInput);
  const smsStats = calculateSmsSegments(textBody);

  const requiresText = mode === 'sms' || mode === 'both';
  const requiresVoice = mode === 'voice' || mode === 'both';

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!parsedPhone.valid) {
      setError(parsedPhone.error || 'Enter a valid Rwandan mobile number.');
      return;
    }
    if (requiresText && textBody.trim().length === 0) {
      setError('Please write a text message.');
      return;
    }
    if (requiresVoice && !audio) {
      setError('Please record a voice audio message before sending.');
      return;
    }

    setSending(true);
    try {
      const res = await apiRequest<{ message: MessageRecord }>('/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          recipientPhone: parsedPhone.e164,
          mode,
          textBody: requiresText ? textBody.trim() : '',
          audioBase64: requiresVoice && audio ? audio.base64 : undefined,
          audioMimeType: requiresVoice && audio ? audio.mimeType : undefined,
          audioDurationSec: requiresVoice && audio ? audio.durationSec : 0,
        }),
      });

      setLastDispatched(res.message);
      onSent(res.message);
      setTextBody('');
      if (audio?.objectUrl) {
        URL.revokeObjectURL(audio.objectUrl);
      }
      setAudio(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
      {/* Main Dispatch Form */}
      <form
        onSubmit={handleSend}
        className="xl:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-6"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Compose Rwandan SMS &amp; Voice Message
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Delivers to +250 non-smartphone button phones, smartphones, and Wi-Fi tablets on MTN
              and Airtel Rwanda
            </p>
          </div>
          <span className="text-xs font-medium text-slate-600 tabular-nums">
            Channel:{' '}
            {gateway.activeProvider === 'pindo'
              ? 'Pindo Rwanda Live (Direct SIM SMS)'
              : gateway.activeProvider === 'africas_talking'
                ? "Africa's Talking Live (Direct SIM SMS)"
                : gateway.activeProvider === 'twilio'
                  ? 'Twilio Live (Direct SIM SMS)'
                  : gateway.activeProvider === 'http_gateway'
                    ? 'HTTP SIM Gateway Live (Direct SMS)'
                    : 'In-App Receiver Relay (Carrier Secret Unset)'}
          </span>
        </div>

        {/* Recipient Rwandan Phone Input */}
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="recipient-phone" className="text-sm font-medium text-slate-800">
              Recipient Rwandan Phone Number
            </label>
            {recipientInput.trim().length > 0 && parsedPhone.valid && (
              <span className="text-xs font-medium text-teal-700 tabular-nums">
                {parsedPhone.carrier} · {parsedPhone.formatted}
              </span>
            )}
          </div>
          <input
            id="recipient-phone"
            type="tel"
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value)}
            placeholder="+250 788 123 456 or 0722 456 789"
            className="w-full px-3.5 py-2.5 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-teal-600"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>Supported prefixes: 078 / 079 (MTN Rwanda) · 072 / 073 (Airtel Rwanda)</span>
            <button
              type="button"
              onClick={() => setRecipientInput('+250 788 452 910')}
              className="text-teal-700 hover:text-teal-800 font-medium whitespace-nowrap"
            >
              Use Sample +250 788 452 910
            </button>
          </div>
          {recipientInput.trim().length > 3 && !parsedPhone.valid && (
            <p className="text-xs text-red-700">{parsedPhone.error}</p>
          )}
        </div>

        {/* Recipient Device Selector */}
        <div className="space-y-2">
          <span className="block text-sm font-medium text-slate-800">Recipient Device</span>
          <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-lg">
            {(
              [
                { id: 'feature', label: 'Button Phone' },
                { id: 'smartphone', label: 'Smartphone' },
                { id: 'tablet', label: 'Tablet' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setRecipientDevice(opt.id)}
                className={`py-2 px-3 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  recipientDevice === opt.id
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Delivery Mode Selector */}
        <div className="space-y-2">
          <span className="block text-sm font-medium text-slate-800">Delivery Mode</span>
          <div className="grid grid-cols-3 gap-1 p-1 bg-slate-100 rounded-lg">
            {(
              [
                { id: 'both', label: 'SMS + Voice Call' },
                { id: 'sms', label: 'Text SMS Only' },
                { id: 'voice', label: 'Voice Call Only' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => setMode(opt.id)}
                className={`py-2 px-3 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                  mode === opt.id
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Written Message Editor */}
        {requiresText && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="sms-body" className="text-sm font-medium text-slate-800">
                Written SMS Message
              </label>
              <span className="text-xs font-mono text-slate-500 tabular-nums">
                {smsStats.chars} chars · {smsStats.segments} SMS {smsStats.segments === 1 ? 'segment' : 'segments'} ({smsStats.encoding})
              </span>
            </div>
            <textarea
              id="sms-body"
              rows={4}
              maxLength={960}
              value={textBody}
              onChange={(e) => setTextBody(e.target.value)}
              placeholder="Write your message in Kinyarwanda, English, or French..."
              className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-teal-600 resize-y"
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-slate-500">Quick starters:</span>
              {QUICK_TEMPLATES.map((tpl) => (
                <button
                  key={tpl.label}
                  type="button"
                  onClick={() => setTextBody(tpl.text)}
                  className="px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors whitespace-nowrap"
                >
                  {tpl.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Voice Audio Recorder */}
        {requiresVoice && <AudioRecorder value={audio} onChange={setAudio} disabled={sending} />}

        {error && (
          <div role="alert" className="p-3 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg">
            {error}
          </div>
        )}

        {lastDispatched && (
          <div
            className={`p-4 border rounded-lg space-y-2 ${
              lastDispatched.status === 'failed'
                ? 'bg-red-50 border-red-200'
                : lastDispatched.status === 'queued'
                  ? 'bg-amber-50 border-amber-200'
                  : 'bg-emerald-50 border-emerald-200'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div
                className={`flex items-center gap-2 text-sm font-semibold ${
                  lastDispatched.status === 'failed'
                    ? 'text-red-900'
                    : lastDispatched.status === 'queued'
                      ? 'text-amber-900'
                      : 'text-emerald-900'
                }`}
              >
                {lastDispatched.status === 'failed' ? (
                  <AlertCircle className="w-4 h-4 text-red-700 shrink-0" />
                ) : lastDispatched.status === 'queued' ? (
                  <Clock className="w-4 h-4 text-amber-700 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
                )}
                {lastDispatched.status === 'failed'
                  ? `Carrier delivery failed for ${lastDispatched.recipientPhone}`
                  : lastDispatched.status === 'queued'
                    ? `Queued at carrier for ${lastDispatched.recipientPhone}`
                    : lastDispatched.gatewayProvider === 'local_relay'
                      ? `Delivered to In-App Receiver (${lastDispatched.recipientPhone})`
                      : `Direct SMS Sent via ${
                          lastDispatched.gatewayProvider === 'pindo'
                            ? 'Pindo Rwanda'
                            : lastDispatched.gatewayProvider === 'africas_talking'
                              ? "Africa's Talking"
                              : lastDispatched.gatewayProvider === 'http_gateway'
                                ? 'HTTP SIM Gateway'
                                : 'Twilio'
                        } to ${lastDispatched.recipientPhone}`}
              </div>
              <span className="text-xs font-mono text-slate-700 tabular-nums">
                Ref: {lastDispatched.gatewayReference}
              </span>
            </div>
            <p
              className={`text-xs ${
                lastDispatched.status === 'failed'
                  ? 'text-red-800'
                  : lastDispatched.status === 'queued'
                    ? 'text-amber-800'
                    : 'text-emerald-800'
              }`}
            >
              {lastDispatched.deliveryNote}
              {lastDispatched.gatewayProvider === 'local_relay' &&
                ' · To deliver directly into their physical phone SMS inbox, configure a carrier secret (PINDO_API_TOKEN, AT_API_KEY, TWILIO_*, or SMS_GATEWAY_URL) in environment Secrets, or tap Send via Device SMS / WhatsApp below.'}
            </p>
            <div className="pt-1 flex flex-wrap items-center gap-2">
              {(() => {
                const links = buildSmartphoneDeliveryLinks({
                  recipientPhone: lastDispatched.recipientPhone,
                  textBody: lastDispatched.textBody,
                  hasAudio: Boolean(lastDispatched.audioUrl),
                  ivrCode: lastDispatched.ivrCode,
                });
                const copyTargetUrl =
                  recipientDevice === 'tablet'
                    ? links.tabletReceiverUrl
                    : links.smartphoneReceiverUrl;
                const copyKind: 'smartphone' | 'tablet' =
                  recipientDevice === 'tablet' ? 'tablet' : 'smartphone';
                return (
                  <>
                    <button
                      type="button"
                      onClick={() => onStartCall(lastDispatched.recipientPhone, recipientDevice)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <PhoneCall className="w-3.5 h-3.5" />
                      Call Live
                    </button>
                    <a
                      href={links.telHref}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-900 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                    >
                      <PhoneCall className="w-3.5 h-3.5 text-emerald-700" />
                      Call via SIM
                    </a>
                    <a
                      href={links.whatsappHref}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-900 bg-white border border-emerald-300 hover:bg-emerald-100 rounded-md transition-colors whitespace-nowrap shrink-0"
                    >
                      <MessageCircle className="w-3.5 h-3.5" />
                      Deliver via WhatsApp
                    </a>
                    <a
                      href={links.smsHref}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-800 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0"
                    >
                      <Send className="w-3.5 h-3.5" />
                      Send via Device SMS
                    </a>
                    <button
                      type="button"
                      onClick={() => onInspectPhone(lastDispatched.recipientPhone, recipientDevice)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-teal-900 bg-white border border-teal-300 hover:bg-teal-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      {recipientDevice === 'tablet' ? (
                        <Tablet className="w-3.5 h-3.5" />
                      ) : (
                        <Smartphone className="w-3.5 h-3.5" />
                      )}
                      {recipientDevice === 'tablet'
                        ? 'Open Tablet Inbox'
                        : recipientDevice === 'smartphone'
                          ? 'Open Smartphone Inbox'
                          : 'Open Phone Inbox'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(copyTargetUrl);
                        setCopiedLinkType(copyKind);
                        setTimeout(() => setCopiedLinkType(null), 2000);
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      {copiedLinkType === copyKind
                        ? `${copyKind === 'tablet' ? 'Tablet' : 'Smartphone'} Link Copied`
                        : `Copy ${copyKind === 'tablet' ? 'Tablet' : 'Smartphone'} Link`}
                    </button>
                  </>
                );
              })()}
            </div>
            {isPrivatePreviewHost() && (
              <p className="text-[11px] text-slate-600 pt-1">
                Opened from private developer preview: links copied here open in this signed-in browser. To open on another physical phone or tablet without &ldquo;Page not found&rdquo;, click Share / Publish first and copy from the published app URL.
              </p>
            )}
          </div>
        )}

        <div className="pt-2 flex flex-wrap items-center justify-end gap-3">
          {parsedPhone.valid && (
            <>
              <a
                href={`tel:${parsedPhone.e164}`}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap"
              >
                <PhoneCall className="w-4 h-4 text-emerald-700" />
                Dial SIM
              </a>
              <button
                type="button"
                onClick={() => onStartCall(parsedPhone.e164, recipientDevice)}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-teal-900 bg-teal-50 hover:bg-teal-100 border border-teal-200 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
              >
                <PhoneCall className="w-4 h-4" />
                Call Live
              </button>
            </>
          )}
          <button
            type="submit"
            disabled={sending}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded-lg transition-colors whitespace-nowrap cursor-pointer"
          >
            <Send className="w-4 h-4" />
            {sending ? 'Dispatching...' : 'Send to Rwandan Phone'}
          </button>
        </div>
      </form>

      {/* Right Device Delivery Preview (Button Phone / Smartphone / Tablet) */}
      <aside className="xl:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="border-b border-slate-200 pb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Recipient Delivery Preview
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              {recipientDevice === 'tablet'
                ? 'How your message & call open in a tablet inbox over Wi-Fi or SIM'
                : recipientDevice === 'smartphone'
                  ? 'How your message & live call arrive on an Android or iPhone smartphone'
                  : 'How your message reaches a standard button phone without internet or apps'}
            </p>
          </div>
          <div className="inline-flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            <button
              type="button"
              onClick={() => setRecipientDevice('feature')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                recipientDevice === 'feature'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Button Phone
            </button>
            <button
              type="button"
              onClick={() => setRecipientDevice('smartphone')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                recipientDevice === 'smartphone'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Smartphone
            </button>
            <button
              type="button"
              onClick={() => setRecipientDevice('tablet')}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap cursor-pointer ${
                recipientDevice === 'tablet'
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              Tablet
            </button>
          </div>
        </div>

        {recipientDevice === 'smartphone' ? (
          <div className="max-w-[310px] mx-auto bg-slate-950 rounded-[2.25rem] p-3.5 border-[5px] border-slate-800 shadow-sm space-y-2.5">
            <div className="flex items-center justify-between text-[11px] font-mono text-slate-300 px-2 tabular-nums">
              <span>{parsedPhone.carrier || 'MTN / Airtel'} · 4G</span>
              <span>{parsedPhone.valid ? parsedPhone.local : '078X XXX XXX'}</span>
            </div>
            <div className="bg-white rounded-[1.5rem] p-4 min-h-[270px] flex flex-col justify-between space-y-3">
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs border-b border-slate-200 pb-2">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-slate-900">
                    <Smartphone className="w-3.5 h-3.5 text-teal-700" />
                    Smartphone Alert
                  </span>
                  <span className="text-[11px] font-mono text-slate-500">Live</span>
                </div>
                {requiresText && (
                  <p className="text-xs text-slate-800 leading-relaxed bg-slate-50 border border-slate-200 rounded-lg p-2.5 break-words">
                    {textBody.trim() || 'Written SMS appears on the recipient smartphone screen...'}
                  </p>
                )}
                {requiresVoice && (
                  <div className="p-2.5 bg-teal-50 border border-teal-200 rounded-lg space-y-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-teal-900">
                      <PhoneCall className="w-3.5 h-3.5 text-teal-700" />
                      Smartphone Call / Voice Note
                    </div>
                    <p className="text-[11px] text-teal-800">
                      {audio
                        ? `Audio (${audio.durationSec}s) + live browser calling enabled.`
                        : 'Supports both recorded voice playback and live browser calling.'}
                    </p>
                  </div>
                )}
              </div>
              <div className="text-[11px] text-slate-500 border-t border-slate-200 pt-2 flex items-center justify-between">
                <span>SMS · WhatsApp · Call</span>
                <span>Live SSE</span>
              </div>
            </div>
          </div>
        ) : recipientDevice === 'tablet' ? (
          <div className="bg-slate-900 rounded-2xl p-3.5 border-4 border-slate-800 shadow-sm space-y-2.5">
            <div className="flex items-center justify-between text-[11px] font-mono text-slate-300 px-1 tabular-nums">
              <span className="inline-flex items-center gap-1.5">
                <Tablet className="w-3.5 h-3.5 text-teal-400" />
                Tablet Inbox
              </span>
              <span>{parsedPhone.valid ? parsedPhone.formatted : '+250 78X XXX XXX'}</span>
            </div>
            <div className="bg-white rounded-xl p-4 min-h-[270px] flex flex-col justify-between space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs border-b border-slate-200 pb-2">
                  <span className="font-semibold text-slate-900">KigaliRelay Live Message</span>
                  <span className="font-mono text-slate-500">
                    {parsedPhone.carrier || 'MTN / Airtel'}
                  </span>
                </div>
                {requiresText && (
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                    <p className="text-sm text-slate-800 leading-relaxed break-words">
                      {textBody.trim() ||
                        'Your written message appears cleanly on the tablet screen...'}
                    </p>
                  </div>
                )}
                {requiresVoice && (
                  <div className="p-3 bg-teal-50 border border-teal-200 rounded-lg space-y-1.5">
                    <div className="flex items-center gap-1.5 text-xs font-semibold text-teal-900">
                      <Volume2 className="w-4 h-4 text-teal-700" />
                      Tablet Voice Audio Player
                    </div>
                    <p className="text-xs text-teal-800">
                      {audio
                        ? `Recorded audio (${audio.durationSec}s) plays instantly through tablet speakers.`
                        : 'Record voice audio to deliver live playback on the tablet.'}
                    </p>
                  </div>
                )}
              </div>
              <div className="text-[11px] text-slate-500 border-t border-slate-200 pt-2 flex items-center justify-between">
                <span>Works on Wi-Fi &amp; SIM tablets</span>
                <span>Live SSE Sync</span>
              </div>
            </div>
          </div>
        ) : (
          /* Classic Handset Frame */
          <div className="max-w-[300px] mx-auto bg-slate-900 rounded-3xl p-4 border-4 border-slate-800 shadow-sm space-y-3">
            <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 px-1">
              <span>{parsedPhone.carrier || 'MTN / AIRTEL RW'}</span>
              <span>GSM 2G · 100%</span>
            </div>

            <div className="bg-emerald-950/90 border border-emerald-800/70 rounded-xl p-3.5 min-h-[210px] flex flex-col justify-between text-emerald-100 space-y-3">
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px] font-mono text-emerald-300 border-b border-emerald-800/60 pb-1.5">
                  <span>{parsedPhone.valid ? parsedPhone.local : '078X XXX XXX'}</span>
                  <span>{mode === 'voice' ? 'VOICE CALL' : mode === 'sms' ? 'NEW SMS' : 'SMS + CALL'}</span>
                </div>

                {requiresText && (
                  <p className="text-xs leading-relaxed text-emerald-50 break-words">
                    {textBody.trim() || 'Your written SMS message appears here on the basic phone screen...'}
                  </p>
                )}

                {requiresVoice && (
                  <div className="p-2 rounded bg-emerald-900/60 border border-emerald-700/50 space-y-1">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-200">
                      <PhoneCall className="w-3.5 h-3.5" />
                      Incoming Voice Audio Call
                    </div>
                    <p className="text-[11px] text-emerald-200/80">
                      {audio
                        ? `Recorded audio (${audio.durationSec}s) plays on answer or via *180*XXXX#`
                        : 'Record voice audio to ring the recipient handset.'}
                    </p>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between text-[10px] font-mono text-emerald-400 pt-2 border-t border-emerald-800/60">
                <span>Options</span>
                <span>Answer / Back</span>
              </div>
            </div>

            {/* Physical Keypad Representation */}
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
      </aside>
    </div>
  );
};
