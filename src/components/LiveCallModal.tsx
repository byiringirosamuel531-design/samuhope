import React, { useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Smartphone,
  Tablet,
  Volume2,
} from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import { getShareableOrigin } from '../lib/rwandaPhone.ts';
import type { CallRecord, ReceiverDeviceMode } from '../types.ts';

export type ActiveCallSession =
  | {
      direction: 'outgoing';
      recipientPhone: string;
      targetDevice: ReceiverDeviceMode;
    }
  | {
      direction: 'incoming';
      call: CallRecord;
      offer: RTCSessionDescriptionInit | null;
    };

interface LiveCallModalProps {
  session: ActiveCallSession;
  onClose: () => void;
}

function formatCallTimer(sec: number): string {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export const LiveCallModal: React.FC<LiveCallModalProps> = ({ session, onClose }) => {
  const [phase, setPhase] = useState<'connecting' | 'ringing' | 'active' | 'ended' | 'error'>(
    'connecting'
  );
  const [callRecord, setCallRecord] = useState<CallRecord | null>(
    session.direction === 'incoming' ? session.call : null
  );
  const [muted, setMuted] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [micBlocked, setMicBlocked] = useState(false);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const callIdRef = useRef<string | null>(
    session.direction === 'incoming' ? session.call.id : null
  );
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescSetRef = useRef(false);
  const closedRef = useRef(false);

  const targetPhone =
    session.direction === 'outgoing' ? session.recipientPhone : session.call.callerPhone;
  const targetDeviceLabel =
    session.direction === 'outgoing'
      ? session.targetDevice === 'tablet'
        ? 'Tablet'
        : session.targetDevice === 'feature'
          ? 'Button Phone'
          : 'Smartphone'
      : 'Incoming Call';

  useEffect(() => {
    if (phase !== 'active') return;
    const timer = window.setInterval(() => {
      setElapsedSec((prev) => prev + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'ringing' || session.direction !== 'outgoing') return;
    let ctx: AudioContext | null = null;
    const playRingPulse = () => {
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) return;
        if (!ctx) ctx = new AudioCtx();
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(440, now);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.exponentialRampToValueAtTime(0.05, now + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.7);
      } catch {
        // Ignore if AudioContext blocked
      }
    };
    playRingPulse();
    const timer = window.setInterval(playRingPulse, 2200);
    return () => {
      window.clearInterval(timer);
      if (ctx) {
        void ctx.close().catch(() => {});
      }
    };
  }, [phase, session.direction]);

  useEffect(() => {
    closedRef.current = false;
    let es: EventSource | null = null;
    let pollTimer: number | null = null;

    function cleanupMedia() {
      if (es) {
        es.close();
        es = null;
      }
      if (pollTimer) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
    }

    async function flushPendingIce(pc: RTCPeerConnection) {
      while (pendingIceRef.current.length > 0) {
        const cand = pendingIceRef.current.shift();
        if (cand) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          } catch {
            // Ignore stale ICE
          }
        }
      }
    }

    async function startCallPipeline() {
      let localStream: MediaStream | null = null;
      if (navigator.mediaDevices?.getUserMedia) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          if (closedRef.current) {
            localStream.getTracks().forEach((t) => t.stop());
            return;
          }
          localStreamRef.current = localStream;
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Microphone permission denied.';
          setMicBlocked(
            msg.toLowerCase().includes('permission') ||
              msg.toLowerCase().includes('allowed') ||
              msg.toLowerCase().includes('notallowed') ||
              (err instanceof DOMException && err.name === 'NotAllowedError')
          );
          setErrorMsg(
            'Microphone is blocked inside this preview frame — call is still placed in listen mode. Open in a new tab for two-way voice, or use Call via Phone SIM.'
          );
        }
      } else {
        setMicBlocked(true);
        setErrorMsg(
          'Browser microphone is unavailable here — call is placed in listen mode. Open in a new tab for two-way voice, or use Call via Phone SIM.'
        );
      }

      const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });
      pcRef.current = pc;

      if (localStream) {
        localStream.getTracks().forEach((track) => {
          pc.addTrack(track, localStream!);
        });
      } else {
        pc.addTransceiver('audio', { direction: 'recvonly' });
      }

      pc.ontrack = (ev) => {
        if (remoteAudioRef.current && ev.streams[0]) {
          remoteAudioRef.current.srcObject = ev.streams[0];
          void remoteAudioRef.current.play().catch(() => {});
        }
      };

      const role: 'caller' | 'callee' =
        session.direction === 'outgoing' ? 'caller' : 'callee';

      pc.onicecandidate = (ev) => {
        if (ev.candidate && callIdRef.current) {
          void apiRequest(`/api/calls/${callIdRef.current}/ice`, {
            method: 'POST',
            body: JSON.stringify({
              role,
              candidate: ev.candidate.toJSON(),
            }),
          }).catch(() => {});
        }
      };

      try {
        if (session.direction === 'outgoing') {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          const created = await apiRequest<{ call: CallRecord }>('/api/calls', {
            method: 'POST',
            body: JSON.stringify({
              recipientPhone: session.recipientPhone,
              targetDevice: session.targetDevice,
              offer,
            }),
          });

          if (closedRef.current) return;
          callIdRef.current = created.call.id;
          setCallRecord(created.call);
          setPhase('ringing');
        } else {
        const activeId = session.call.id;
        callIdRef.current = activeId;

        let remoteOffer = session.offer;
        if (!remoteOffer) {
          const fetched = await apiRequest<{ offer: RTCSessionDescriptionInit | null }>(
            `/api/calls/${activeId}`
          );
          remoteOffer = fetched.offer;
        }
        if (remoteOffer) {
          await pc.setRemoteDescription(new RTCSessionDescription(remoteOffer));
          remoteDescSetRef.current = true;
          await flushPendingIce(pc);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          const answered = await apiRequest<{ call: CallRecord }>(`/api/calls/${activeId}/answer`, {
            method: 'POST',
            body: JSON.stringify({ answer }),
          });
          setCallRecord(answered.call);
          setPhase('active');
        } else {
          await apiRequest(`/api/calls/${activeId}/answer`, {
            method: 'POST',
            body: JSON.stringify({}),
          });
          setPhase('active');
        }
      }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Unable to start voice call.');
        setPhase('error');
        return;
      }

      const activeId = callIdRef.current;
      if (!activeId) return;

      const addedKeys = new Set<string>();
      const handleRemoteCandidate = async (cand: RTCIceCandidateInit) => {
        const key = JSON.stringify(cand);
        if (addedKeys.has(key)) return;
        addedKeys.add(key);
        if (remoteDescSetRef.current && pcRef.current) {
          try {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(cand));
          } catch {
            // Ignore stale ICE
          }
        } else {
          pendingIceRef.current.push(cand);
        }
      };

      es = new EventSource(`/api/calls/${activeId}/stream`);
      es.addEventListener('call_state', (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent<string>).data) as {
            call: CallRecord;
            answer: RTCSessionDescriptionInit | null;
            callerCandidates: RTCIceCandidateInit[];
            calleeCandidates: RTCIceCandidateInit[];
          };
          setCallRecord(payload.call);
          if (
            session.direction === 'outgoing' &&
            payload.answer &&
            !remoteDescSetRef.current &&
            pcRef.current
          ) {
            void pcRef.current
              .setRemoteDescription(new RTCSessionDescription(payload.answer))
              .then(() => {
                remoteDescSetRef.current = true;
                setPhase('active');
                return flushPendingIce(pcRef.current!);
              })
              .catch(() => {});
          }
          const remoteList =
            session.direction === 'outgoing'
              ? payload.calleeCandidates
              : payload.callerCandidates;
          remoteList.forEach((c) => {
            void handleRemoteCandidate(c);
          });
        } catch {
          // Ignore parse error
        }
      });

      es.addEventListener('call_answered', (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent<string>).data) as {
            call: CallRecord;
            answer: RTCSessionDescriptionInit | null;
          };
          setCallRecord(payload.call);
          if (
            session.direction === 'outgoing' &&
            payload.answer &&
            !remoteDescSetRef.current &&
            pcRef.current
          ) {
            void pcRef.current
              .setRemoteDescription(new RTCSessionDescription(payload.answer))
              .then(() => {
                remoteDescSetRef.current = true;
                setPhase('active');
                return flushPendingIce(pcRef.current!);
              })
              .catch(() => {});
          } else {
            setPhase('active');
          }
        } catch {
          // Ignore parse error
        }
      });

      es.addEventListener('call_ice', (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent<string>).data) as {
            role: 'caller' | 'callee';
            candidate: RTCIceCandidateInit;
          };
          if (payload.role !== role) {
            void handleRemoteCandidate(payload.candidate);
          }
        } catch {
          // Ignore parse error
        }
      });

      es.addEventListener('call_ended', (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent<string>).data) as { call: CallRecord };
          setCallRecord(payload.call);
        } catch {
          // Ignore parse error
        }
        setPhase('ended');
        cleanupMedia();
      });

      // Lightweight fallback poll in case SSE misses an event
      pollTimer = window.setInterval(() => {
        if (!callIdRef.current) return;
        void apiRequest<{
          call: CallRecord;
          answer: RTCSessionDescriptionInit | null;
          callerCandidates: RTCIceCandidateInit[];
          calleeCandidates: RTCIceCandidateInit[];
        }>(`/api/calls/${callIdRef.current}`)
          .then((data) => {
            if (data.call.status === 'ended' || data.call.status === 'declined') {
              setCallRecord(data.call);
              setPhase('ended');
              cleanupMedia();
              return;
            }
            if (
              session.direction === 'outgoing' &&
              data.answer &&
              !remoteDescSetRef.current &&
              pcRef.current
            ) {
              void pcRef.current
                .setRemoteDescription(new RTCSessionDescription(data.answer))
                .then(() => {
                  remoteDescSetRef.current = true;
                  setPhase('active');
                  return flushPendingIce(pcRef.current!);
                })
                .catch(() => {});
            }
            const remoteList =
              session.direction === 'outgoing' ? data.calleeCandidates : data.callerCandidates;
            remoteList.forEach((c) => {
              void handleRemoteCandidate(c);
            });
          })
          .catch(() => {});
      }, 2500);
    }

    void startCallPipeline();

    return () => {
      closedRef.current = true;
      cleanupMedia();
    };
  }, [session]);

  function toggleMute() {
    if (!localStreamRef.current) return;
    const next = !muted;
    localStreamRef.current.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    setMuted(next);
  }

  async function handleHangUp() {
    if (callIdRef.current && phase !== 'ended') {
      try {
        await apiRequest(`/api/calls/${callIdRef.current}/end`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'ended' }),
        });
      } catch {
        // Ignore network errors on close
      }
    }
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Live Voice Call"
      className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4"
    >
      <div className="w-full max-w-md bg-slate-950 text-white border border-slate-800 rounded-2xl p-6 space-y-6 shadow-xl">
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

        <div className="flex items-center justify-between text-xs text-slate-400">
          <span className="inline-flex items-center gap-1.5 font-medium text-teal-300">
            {session.direction === 'outgoing' && session.targetDevice === 'tablet' ? (
              <Tablet className="w-3.5 h-3.5" />
            ) : (
              <Smartphone className="w-3.5 h-3.5" />
            )}
            {targetDeviceLabel}
          </span>
          <span className="font-mono tabular-nums">
            {phase === 'active'
              ? formatCallTimer(elapsedSec)
              : phase === 'ringing'
                ? 'Ringing...'
                : phase === 'connecting'
                  ? 'Connecting...'
                  : phase === 'ended'
                    ? 'Call Ended'
                    : 'Action Needed'}
          </span>
        </div>

        <div className="text-center space-y-2 py-2">
          <div className="w-16 h-16 rounded-full bg-teal-900/60 border border-teal-700/60 mx-auto flex items-center justify-center">
            <PhoneCall className="w-7 h-7 text-teal-300" />
          </div>
          <h3 className="text-lg font-semibold text-white">
            {session.direction === 'incoming'
              ? session.call.callerName
              : callRecord?.recipientPhone || session.recipientPhone}
          </h3>
          <p className="text-sm font-mono text-slate-300 tabular-nums">{targetPhone}</p>
          <p className="text-xs text-slate-400">
            {phase === 'ringing' &&
              'Ringing recipient on their KigaliRelay Smartphone / Tablet / Phone Receiver...'}
            {phase === 'active' && 'Live two-way voice audio connected'}
            {phase === 'connecting' && 'Preparing microphone and voice channel...'}
            {phase === 'ended' &&
              `Call finished${callRecord?.durationSec ? ` (${formatCallTimer(callRecord.durationSec)})` : ''}`}
          </p>
        </div>

        {errorMsg && (
          <div className="p-3 bg-amber-950/80 border border-amber-800 rounded-lg text-xs text-amber-200 space-y-2">
            <p>{errorMsg}</p>
            {micBlocked && (
              <a
                href={
                  typeof window !== 'undefined'
                    ? `${getShareableOrigin()}${window.location.pathname}${window.location.search}`
                    : '/'
                }
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-teal-950 bg-teal-300 hover:bg-teal-200 rounded-md"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open in New Tab to Allow Microphone
              </a>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          {(phase === 'ringing' || phase === 'active') && (
            <button
              type="button"
              onClick={toggleMute}
              className={`min-h-[44px] inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl border transition-colors cursor-pointer ${
                muted
                  ? 'bg-amber-600 border-amber-500 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
              }`}
            >
              {muted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              {muted ? 'Unmute Mic' : 'Mute Mic'}
            </button>
          )}

          <a
            href={`tel:${targetPhone}`}
            className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-emerald-100 bg-emerald-800/80 hover:bg-emerald-700 border border-emerald-700 rounded-xl transition-colors whitespace-nowrap"
          >
            <Volume2 className="w-4 h-4" />
            Call via Phone SIM
          </a>

          <button
            type="button"
            onClick={() => void handleHangUp()}
            className="min-h-[44px] inline-flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors cursor-pointer whitespace-nowrap"
          >
            <PhoneOff className="w-4 h-4" />
            {phase === 'ended' || phase === 'error' ? 'Close' : 'End Call'}
          </button>
        </div>
      </div>
    </div>
  );
};
