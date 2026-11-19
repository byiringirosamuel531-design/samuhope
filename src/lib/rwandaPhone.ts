export type RwandanCarrier = 'MTN Rwanda' | 'Airtel Rwanda';

export interface ParsedRwandaPhone {
  valid: boolean;
  e164: string;
  formatted: string;
  local: string;
  carrier: RwandanCarrier | null;
  error?: string;
}

/**
 * Validates and normalizes Rwandan mobile numbers:
 * - MTN Rwanda: 078x xxx xxx, 079x xxx xxx
 * - Airtel Rwanda: 072x xxx xxx, 073x xxx xxx
 * Accepts formats like 0788123456, 788123456, 250788123456, +250 788 123 456.
 */
export function parseRwandaPhone(rawInput: string): ParsedRwandaPhone {
  const cleaned = rawInput.replace(/[\s\-().]/g, '');

  let national = '';
  if (cleaned.startsWith('+250')) {
    national = cleaned.slice(4);
    if (national.startsWith('0') && national.length === 10) {
      national = national.slice(1);
    }
  } else if (cleaned.startsWith('250')) {
    national = cleaned.slice(3);
    if (national.startsWith('0') && national.length === 10) {
      national = national.slice(1);
    }
  } else if (cleaned.startsWith('07') && cleaned.length === 10) {
    national = cleaned.slice(1);
  } else if (cleaned.startsWith('7') && cleaned.length === 9) {
    national = cleaned;
  } else {
    return {
      valid: false,
      e164: '',
      formatted: rawInput,
      local: rawInput,
      carrier: null,
      error: 'Enter a valid 9-digit Rwandan mobile number (078, 079, 072, or 073).',
    };
  }

  if (!/^7[2389]\d{7}$/.test(national)) {
    return {
      valid: false,
      e164: '',
      formatted: rawInput,
      local: rawInput,
      carrier: null,
      error: 'Rwandan mobile numbers must start with 078, 079 (MTN) or 072, 073 (Airtel).',
    };
  }

  const prefix = national.slice(0, 2);
  const carrier: RwandanCarrier =
    prefix === '78' || prefix === '79' ? 'MTN Rwanda' : 'Airtel Rwanda';

  const e164 = `+250${national}`;
  const formatted = `+250 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;
  const local = `0${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`;

  return {
    valid: true,
    e164,
    formatted,
    local,
    carrier,
  };
}

export function calculateSmsSegments(text: string): {
  chars: number;
  segments: number;
  encoding: 'GSM-7' | 'Unicode';
  perSegment: number;
} {
  const chars = text.length;
  if (chars === 0) {
    return { chars: 0, segments: 0, encoding: 'GSM-7', perSegment: 160 };
  }
  // Basic ASCII/GSM-7 check
  const isGsm7 = /^[\x20-\x7E\r\n]*$/.test(text);
  const singleLimit = isGsm7 ? 160 : 70;
  const multiLimit = isGsm7 ? 153 : 67;
  const segments = chars <= singleLimit ? 1 : Math.ceil(chars / multiLimit);

  return {
    chars,
    segments,
    encoding: isGsm7 ? 'GSM-7' : 'Unicode',
    perSegment: segments <= 1 ? singleLimit : multiLimit,
  };
}

export function isPrivatePreviewHost(): boolean {
  return typeof window !== 'undefined' && window.location.hostname.startsWith('ais-dev-');
}

export function getShareableOrigin(origin?: string): string {
  return (origin || (typeof window !== 'undefined' ? window.location.origin : '')).replace(
    /\/$/,
    ''
  );
}

export function buildSmartphoneDeliveryLinks(params: {
  recipientPhone: string;
  textBody?: string;
  hasAudio?: boolean;
  ivrCode?: string;
  origin?: string;
}) {
  const baseOrigin = getShareableOrigin(params.origin);
  const receiverUrl = `${baseOrigin}/?receiver=${encodeURIComponent(params.recipientPhone)}`;
  const smartphoneReceiverUrl = `${baseOrigin}/?receiver=${encodeURIComponent(params.recipientPhone)}&device=smartphone`;
  const tabletReceiverUrl = `${baseOrigin}/?receiver=${encodeURIComponent(params.recipientPhone)}&device=tablet`;
  const parts: string[] = [];
  if (params.textBody && params.textBody.trim()) {
    parts.push(params.textBody.trim());
  }
  if (params.hasAudio) {
    parts.push(
      `Listen to voice message on your phone or tablet${params.ivrCode ? ` (IVR *180*${params.ivrCode}#)` : ''}: ${receiverUrl}`
    );
  } else if (parts.length === 0) {
    parts.push(`Open your KigaliRelay message inbox: ${receiverUrl}`);
  }
  const combinedText = parts.join('\n\n');
  const waDigits = params.recipientPhone.replace(/\D/g, '');

  return {
    receiverUrl,
    smartphoneReceiverUrl,
    tabletReceiverUrl,
    telHref: `tel:${params.recipientPhone}`,
    whatsappHref: `https://wa.me/${waDigits}?text=${encodeURIComponent(combinedText)}`,
    smsHref: `sms:${params.recipientPhone}?body=${encodeURIComponent(combinedText)}`,
  };
}
