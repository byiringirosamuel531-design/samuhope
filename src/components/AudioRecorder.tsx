import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, Mic, Pause, Play, RotateCcw, Square, Trash2, Upload } from 'lucide-react';
import { getShareableOrigin } from '../lib/rwandaPhone.ts';

export interface RecordedAudioPayload {
  base64: string;
  mimeType: string;
  durationSec: number;
  objectUrl: string;
}

interface AudioRecorderProps {
  value: RecordedAudioPayload | null;
  onChange: (payload: RecordedAudioPayload | null) => void;
  disabled?: boolean;
}

function formatDuration(totalSec: number): string {
  const mins = Math.floor(totalSec / 60);
  const secs = Math.floor(totalSec % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const AudioRecorder: React.FC<AudioRecorderProps> = ({
  value,
  onChange,
  disabled = false,
}) => {
  const [status, setStatus] = useState<'idle' | 'recording' | 'paused' | 'recorded'>(
    value ? 'recorded' : 'idle'
  );
  const [elapsedSec, setElapsedSec] = useState(value ? value.durationSec : 0);
  const [micError, setMicError] = useState<string | null>(null);
  const [micBlockedByFrame, setMicBlockedByFrame] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const elapsedRef = useRef<number>(0);

  useEffect(() => {
    if (!value && status === 'recorded') {
      setStatus('idle');
      setElapsedSec(0);
      elapsedRef.current = 0;
    }
  }, [value, status]);

  useEffect(() => {
    return () => {
      cleanupAudioPipeline();
    };
  }, []);

  function cleanupAudioPipeline() {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
  }

  function drawWaveform() {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const renderFrame = () => {
      if (!analyserRef.current) return;
      rafRef.current = window.requestAnimationFrame(renderFrame);
      analyser.getByteFrequencyData(dataArray);

      const width = canvas.width;
      const height = canvas.height;
      ctx.clearRect(0, 0, width, height);

      const barCount = 40;
      const step = Math.max(1, Math.floor(bufferLength / barCount));
      const gap = 3;
      const barWidth = (width - gap * (barCount - 1)) / barCount;

      for (let i = 0; i < barCount; i++) {
        const val = dataArray[i * step] || 0;
        const barHeight = Math.max(4, (val / 255) * (height - 8));
        const x = i * (barWidth + gap);
        const y = (height - barHeight) / 2;
        ctx.fillStyle = '#0f766e';
        ctx.fillRect(x, y, barWidth, barHeight);
      }
    };

    renderFrame();
  }

  async function startRecording() {
    if (disabled) return;
    setMicError(null);
    setMicBlockedByFrame(false);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setMicError('Live microphone recording is unavailable here. Use Upload Audio or open in a new tab.');
      setMicBlockedByFrame(true);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      const mimeCandidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      const supportedMime =
        mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';

      const recorder = supportedMime
        ? new MediaRecorder(stream, { mimeType: supportedMime })
        : new MediaRecorder(stream);

      chunksRef.current = [];
      elapsedRef.current = 0;
      setElapsedSec(0);

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          chunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = () => {
        const finalMime = recorder.mimeType || supportedMime || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: finalMime });
        const duration = Math.max(1, elapsedRef.current);
        const objectUrl = URL.createObjectURL(blob);

        const reader = new FileReader();
        reader.onloadend = () => {
          const result = typeof reader.result === 'string' ? reader.result : '';
          onChange({
            base64: result,
            mimeType: finalMime,
            durationSec: duration,
            objectUrl,
          });
          setStatus('recorded');
        };
        reader.readAsDataURL(blob);
        cleanupAudioPipeline();
      };

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      source.connect(analyser);
      audioCtxRef.current = audioCtx;
      analyserRef.current = analyser;

      mediaRecorderRef.current = recorder;
      recorder.start(250);
      setStatus('recording');

      timerRef.current = window.setInterval(() => {
        elapsedRef.current += 1;
        setElapsedSec(elapsedRef.current);
        if (elapsedRef.current >= 120 && mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      }, 1000);

      window.setTimeout(() => drawWaveform(), 40);
    } catch (err) {
      cleanupAudioPipeline();
      const rawMsg = err instanceof Error ? err.message : 'Could not access microphone.';
      const isPolicyBlock =
        rawMsg.toLowerCase().includes('permission') ||
        rawMsg.toLowerCase().includes('not allowed') ||
        (err instanceof DOMException && err.name === 'NotAllowedError');
      setMicBlockedByFrame(isPolicyBlock);
      setMicError(
        isPolicyBlock
          ? 'Microphone is blocked inside the embedded preview frame. Open the app in a new tab to record live, or upload an audio file below.'
          : `Microphone access unavailable: ${rawMsg}`
      );
    }
  }

  function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setMicError(null);
    if (file.size > 10 * 1024 * 1024) {
      setMicError('Audio file exceeds the 10 MB limit.');
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    const probe = new Audio(objectUrl);

    const finalizeWithDuration = (durationSec: number) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const dur = Math.max(1, Math.round(durationSec || 1));
        setElapsedSec(dur);
        onChange({
          base64: result,
          mimeType: file.type || 'audio/mpeg',
          durationSec: dur,
          objectUrl,
        });
        setStatus('recorded');
      };
      reader.readAsDataURL(file);
    };

    probe.onloadedmetadata = () => {
      finalizeWithDuration(Number.isFinite(probe.duration) ? probe.duration : 1);
    };
    probe.onerror = () => {
      finalizeWithDuration(1);
    };
  }

  function pauseOrResume() {
    const rec = mediaRecorderRef.current;
    if (!rec) return;
    if (rec.state === 'recording') {
      rec.pause();
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setStatus('paused');
    } else if (rec.state === 'paused') {
      rec.resume();
      timerRef.current = window.setInterval(() => {
        elapsedRef.current += 1;
        setElapsedSec(elapsedRef.current);
        if (elapsedRef.current >= 120 && mediaRecorderRef.current?.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      }, 1000);
      setStatus('recording');
    }
  }

  function stopRecording() {
    const rec = mediaRecorderRef.current;
    if (rec && (rec.state === 'recording' || rec.state === 'paused')) {
      rec.stop();
    }
  }

  function discardRecording() {
    if (value?.objectUrl) {
      URL.revokeObjectURL(value.objectUrl);
    }
    onChange(null);
    setElapsedSec(0);
    elapsedRef.current = 0;
    setStatus('idle');
  }

  return (
    <div className="border border-slate-200 rounded-xl bg-slate-50 p-4 space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Voice Audio Recording</h3>
          <p className="text-xs text-slate-500">
            Played automatically when the Rwandan phone answers the voice call (max 02:00)
          </p>
        </div>
        <span className="font-mono text-sm font-semibold text-slate-900 tabular-nums whitespace-nowrap">
          {formatDuration(elapsedSec)} / 02:00
        </span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        onChange={handleFileSelected}
        className="hidden"
      />

      {micError && (
        <div role="alert" className="p-3 text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg space-y-2">
          <p>{micError}</p>
          {micBlockedByFrame && (
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={
                  typeof window !== 'undefined'
                    ? `${getShareableOrigin()}${window.location.pathname}${window.location.search}`
                    : '/'
                }
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-semibold text-teal-900 bg-white border border-teal-300 hover:bg-teal-50 rounded-md"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                Open App in New Tab for Microphone
              </a>
            </div>
          )}
        </div>
      )}

      {status === 'idle' && (
        <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-slate-200 rounded-lg p-3">
          <span className="text-xs text-slate-600">
            Record directly with your microphone or upload an audio clip.
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              Upload Audio
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => void startRecording()}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Mic className="w-4 h-4" />
              Start Recording
            </button>
          </div>
        </div>
      )}

      {(status === 'recording' || status === 'paused') && (
        <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-slate-700">
              {status === 'recording' ? 'Recording live audio...' : 'Recording paused'}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={pauseOrResume}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap"
              >
                {status === 'recording' ? (
                  <>
                    <Pause className="w-3.5 h-3.5" />
                    Pause
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5" />
                    Resume
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={stopRecording}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-red-700 hover:bg-red-800 rounded-lg transition-colors whitespace-nowrap"
              >
                <Square className="w-3.5 h-3.5" />
                Stop
              </button>
            </div>
          </div>
          <canvas
            ref={canvasRef}
            width={460}
            height={48}
            className="w-full h-12 rounded bg-slate-50 border border-slate-200"
          />
        </div>
      )}

      {status === 'recorded' && value && (
        <div className="bg-white border border-slate-200 rounded-lg p-3 space-y-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-emerald-700">
              Audio recorded · {value.durationSec}s ready for voice delivery
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                Replace File
              </button>
              <button
                type="button"
                onClick={() => {
                  discardRecording();
                  void startRecording();
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Re-record
              </button>
              <button
                type="button"
                onClick={discardRecording}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 rounded-md transition-colors whitespace-nowrap cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remove
              </button>
            </div>
          </div>
          <audio controls src={value.objectUrl} className="w-full h-9" />
        </div>
      )}
    </div>
  );
};
