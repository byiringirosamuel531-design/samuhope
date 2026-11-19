import crypto from 'node:crypto';

export interface GatewayDispatchInput {
  messageId: string;
  recipientPhone: string;
  recipientCarrier: string;
  mode: 'sms' | 'voice' | 'both';
  textBody: string;
  audioUrl: string | null;
  ivrCode: string;
  requestOrigin?: string;
}

export interface GatewayDispatchResult {
  provider: 'pindo' | 'africas_talking' | 'twilio' | 'http_gateway' | 'local_relay';
  reference: string;
  status: 'delivered_gateway' | 'delivered_relay' | 'queued' | 'failed';
  note: string;
}

export function getGatewayStatus(requestOrigin?: string) {
  const pindoConfigured = Boolean(process.env.PINDO_API_TOKEN?.trim());
  const atConfigured = Boolean(process.env.AT_API_KEY?.trim() && process.env.AT_USERNAME?.trim());
  const twilioConfigured = Boolean(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
      process.env.TWILIO_AUTH_TOKEN?.trim() &&
      process.env.TWILIO_FROM_NUMBER?.trim()
  );
  const httpGatewayConfigured = Boolean(process.env.SMS_GATEWAY_URL?.trim());

  const activeProvider: GatewayDispatchResult['provider'] = pindoConfigured
    ? 'pindo'
    : atConfigured
      ? 'africas_talking'
      : twilioConfigured
        ? 'twilio'
        : httpGatewayConfigured
          ? 'http_gateway'
          : 'local_relay';

  const resolvedOrigin = (process.env.APP_URL || requestOrigin || 'http://localhost:3000').replace(
    /\/$/,
    ''
  );

  return {
    activeProvider,
    pindoConfigured,
    africasTalkingConfigured: atConfigured,
    twilioConfigured,
    httpGatewayConfigured,
    appUrl: resolvedOrigin,
  };
}

export async function dispatchRwandaMessage(
  input: GatewayDispatchInput
): Promise<GatewayDispatchResult> {
  const gateway = getGatewayStatus(input.requestOrigin);
  const baseUrl = gateway.appUrl.replace(/\/$/, '');
  const receiverLink = `${baseUrl}/?receiver=${encodeURIComponent(input.recipientPhone)}`;

  // 1. Pindo Rwanda SMS API (Direct MTN & Airtel Rwanda Physical Phone SMS)
  if (gateway.pindoConfigured) {
    const token = (process.env.PINDO_API_TOKEN as string).trim();
    const sender = (process.env.PINDO_SENDER_ID || 'PindoTest').trim();
    const smsText =
      input.mode === 'sms'
        ? input.textBody
        : input.mode === 'both'
          ? `${input.textBody}\nVoice note (IVR *180*${input.ivrCode}#): ${receiverLink}`
          : `You have a new KigaliRelay voice message (IVR *180*${input.ivrCode}#). Listen here: ${receiverLink}`;

    try {
      const res = await fetch('https://api.pindo.io/v1/sms/', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          to: input.recipientPhone,
          text: smsText,
          sender,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        sms_id?: string | number;
        id?: string | number;
        message_id?: string | number;
        status?: string;
        message?: string;
        detail?: string;
        error?: string;
      };

      if (res.ok) {
        const ref = String(
          data.sms_id || data.id || data.message_id || `PINDO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
        );
        return {
          provider: 'pindo',
          reference: ref,
          status: 'delivered_gateway',
          note: `Direct SMS dispatched via Pindo Rwanda to ${input.recipientCarrier} SIM inbox (${data.status || 'sent'})`,
        };
      }

      return {
        provider: 'pindo',
        reference: `PINDO-ERR-${Date.now()}`,
        status: 'failed',
        note: `Pindo SMS error (${res.status}): ${data.message || data.detail || data.error || res.statusText}`,
      };
    } catch (err) {
      return {
        provider: 'pindo',
        reference: `PINDO-ERR-${Date.now()}`,
        status: 'failed',
        note: err instanceof Error ? err.message : 'Pindo SMS request failed',
      };
    }
  }

  // 2. Africa's Talking (Primary Rwandan MTN/Airtel SMS & Voice Gateway)
  if (gateway.africasTalkingConfigured) {
    const username = (process.env.AT_USERNAME as string).trim();
    const apiKey = (process.env.AT_API_KEY as string).trim();
    const senderId = (process.env.AT_SENDER_ID || '').trim();
    const voiceFrom = (process.env.AT_VOICE_NUMBER || '').trim();
    const isSandbox = username.toLowerCase() === 'sandbox';

    const smsEndpoint = isSandbox
      ? 'https://api.sandbox.africastalking.com/version1/messaging'
      : 'https://api.africastalking.com/version1/messaging';
    const voiceEndpoint = isSandbox
      ? 'https://voice.sandbox.africastalking.com/call'
      : 'https://voice.africastalking.com/call';

    const notes: string[] = [];
    const refs: string[] = [];
    let anySuccess = false;
    let onlyQueued = true;

    try {
      if (input.mode === 'sms' || input.mode === 'both') {
        const smsText =
          input.mode === 'both'
            ? `${input.textBody}\n[Voice note attached — Dial *180*${input.ivrCode}# or open ${receiverLink}]`
            : input.textBody;

        const form = new URLSearchParams({
          username,
          to: input.recipientPhone,
          message: smsText,
        });
        if (senderId) form.set('from', senderId);

        const smsRes = await fetch(smsEndpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            apiKey,
          },
          body: form.toString(),
        });

        const smsJson = (await smsRes.json()) as {
          SMSMessageData?: {
            Message?: string;
            Recipients?: Array<{
              status?: string;
              statusCode?: number;
              messageId?: string;
              cost?: string;
            }>;
          };
        };

        const recipientRes = smsJson.SMSMessageData?.Recipients?.[0];
        const statusText = (recipientRes?.status || '').toLowerCase();
        const code = Number(recipientRes?.statusCode || 0);
        const smsAccepted =
          smsRes.ok &&
          Boolean(recipientRes) &&
          (code === 100 ||
            code === 101 ||
            code === 102 ||
            statusText === 'success' ||
            statusText === 'sent' ||
            statusText === 'queued');

        if (smsAccepted && recipientRes) {
          anySuccess = true;
          if (code !== 102 && statusText !== 'queued') {
            onlyQueued = false;
          }
          refs.push(recipientRes.messageId || `AT-SMS-${Date.now()}`);
          notes.push(
            `Direct SMS sent via Africa's Talking${isSandbox ? ' (Sandbox)' : ''} (${recipientRes.status || 'Sent'})`
          );
        } else {
          const reason =
            recipientRes?.status || smsJson.SMSMessageData?.Message || smsRes.statusText;
          notes.push(`AT SMS rejected: ${reason}`);
        }
      }

      if ((input.mode === 'voice' || input.mode === 'both') && input.audioUrl && voiceFrom) {
        const callForm = new URLSearchParams({
          username,
          from: voiceFrom,
          to: input.recipientPhone,
        });
        const voiceRes = await fetch(voiceEndpoint, {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            apiKey,
          },
          body: callForm.toString(),
        });
        const voiceJson = (await voiceRes.json().catch(() => ({}))) as {
          entries?: Array<{ status?: string; sessionId?: string }>;
          errorMessage?: string;
        };
        const entry = voiceJson.entries?.[0];
        if (voiceRes.ok && (!entry?.status || entry.status.toLowerCase() === 'queued')) {
          anySuccess = true;
          refs.push(entry?.sessionId || `AT-VOICE-${Date.now()}`);
          notes.push(`Voice call initiated to ${input.recipientPhone}`);
        } else {
          notes.push(
            `AT Voice error: ${voiceJson.errorMessage || entry?.status || `HTTP ${voiceRes.status}`}`
          );
        }
      } else if ((input.mode === 'voice' || input.mode === 'both') && !voiceFrom) {
        notes.push('AT_VOICE_NUMBER not set; audio available via Phone Receiver & Voice XML');
      }

      return {
        provider: 'africas_talking',
        reference: refs.join(',') || `AT-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        status: !anySuccess ? 'failed' : onlyQueued ? 'queued' : 'delivered_gateway',
        note: notes.join(' · '),
      };
    } catch (err) {
      return {
        provider: 'africas_talking',
        reference: `AT-ERR-${Date.now()}`,
        status: 'failed',
        note: err instanceof Error ? err.message : "Africa's Talking request failed",
      };
    }
  }

  // 3. Twilio Gateway
  if (gateway.twilioConfigured) {
    const sid = (process.env.TWILIO_ACCOUNT_SID as string).trim();
    const token = (process.env.TWILIO_AUTH_TOKEN as string).trim();
    const from = (process.env.TWILIO_FROM_NUMBER as string).trim();
    const authHeader = `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;

    const notes: string[] = [];
    const refs: string[] = [];
    let anySuccess = false;
    let anyDelivered = false;

    try {
      if (input.mode === 'sms' || input.mode === 'both') {
        const smsText =
          input.mode === 'both'
            ? `${input.textBody}\n[Voice call incoming — IVR code *180*${input.ivrCode}#]`
            : input.textBody;

        const form = new URLSearchParams({
          To: input.recipientPhone,
          From: from,
          Body: smsText,
          StatusCallback: `${baseUrl}/api/gateway/sms-status?messageId=${encodeURIComponent(input.messageId)}`,
        });

        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        });
        const data = (await res.json()) as { sid?: string; status?: string; message?: string };
        if (res.ok && data.sid) {
          anySuccess = true;
          if (data.status === 'sent' || data.status === 'delivered') {
            anyDelivered = true;
          }
          refs.push(data.sid);
          notes.push(`Direct SMS submitted to Twilio (${data.status || 'queued'}, ${data.sid})`);
        } else {
          notes.push(`Twilio SMS error: ${data.message || res.statusText}`);
        }
      }

      if ((input.mode === 'voice' || input.mode === 'both') && input.audioUrl) {
        const twimlUrl = `${baseUrl}/api/gateway/voice-xml/${input.messageId}`;
        const callForm = new URLSearchParams({
          To: input.recipientPhone,
          From: from,
          Url: twimlUrl,
          StatusCallback: `${baseUrl}/api/gateway/voice-status?messageId=${encodeURIComponent(input.messageId)}`,
        });
        const callRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: callForm.toString(),
        });
        const callData = (await callRes.json()) as { sid?: string; status?: string; message?: string };
        if (callRes.ok && callData.sid) {
          anySuccess = true;
          refs.push(callData.sid);
          notes.push(`Voice call initiated via Twilio (${callData.sid})`);
        } else {
          notes.push(`Twilio Voice error: ${callData.message || callRes.statusText}`);
        }
      }

      return {
        provider: 'twilio',
        reference: refs.join(',') || `TW-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        status: !anySuccess ? 'failed' : anyDelivered ? 'delivered_gateway' : 'queued',
        note: notes.join(' · '),
      };
    } catch (err) {
      return {
        provider: 'twilio',
        reference: `TW-ERR-${Date.now()}`,
        status: 'failed',
        note: err instanceof Error ? err.message : 'Twilio request failed',
      };
    }
  }

  // 4. Custom HTTP / Android SIM SMS Gateway Webhook
  if (gateway.httpGatewayConfigured) {
    const gatewayUrl = (process.env.SMS_GATEWAY_URL as string).trim();
    const gatewayToken = (process.env.SMS_GATEWAY_TOKEN || '').trim();
    const smsText =
      input.mode === 'sms'
        ? input.textBody
        : input.mode === 'both'
          ? `${input.textBody}\nVoice note (IVR *180*${input.ivrCode}#): ${receiverLink}`
          : `New KigaliRelay voice message (IVR *180*${input.ivrCode}#): ${receiverLink}`;

    try {
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      };
      if (gatewayToken) {
        headers.Authorization = `Bearer ${gatewayToken}`;
      }

      const res = await fetch(gatewayUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          to: input.recipientPhone,
          phone: input.recipientPhone,
          message: smsText,
          text: smsText,
          carrier: input.recipientCarrier,
          reference: input.messageId,
        }),
      });

      const data = (await res.json().catch(() => ({}))) as {
        id?: string;
        reference?: string;
        status?: string;
        error?: string;
        message?: string;
      };

      if (res.ok) {
        return {
          provider: 'http_gateway',
          reference: String(
            data.id || data.reference || `SIMGW-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
          ),
          status: 'delivered_gateway',
          note: `Direct SMS sent via HTTP SIM Gateway to ${input.recipientCarrier} phone`,
        };
      }

      return {
        provider: 'http_gateway',
        reference: `SIMGW-ERR-${Date.now()}`,
        status: 'failed',
        note: `HTTP SMS Gateway error (${res.status}): ${data.error || data.message || res.statusText}`,
      };
    } catch (err) {
      return {
        provider: 'http_gateway',
        reference: `SIMGW-ERR-${Date.now()}`,
        status: 'failed',
        note: err instanceof Error ? err.message : 'HTTP SMS Gateway request failed',
      };
    }
  }

  // 5. Built-in Rwandan Feature-Phone Relay (when external carrier keys are not set)
  const refCode = `RW-${input.recipientCarrier === 'MTN Rwanda' ? 'MTN' : 'AIR'}-${crypto
    .randomBytes(3)
    .toString('hex')
    .toUpperCase()}`;

  const deliveryParts: string[] = [];
  if (input.mode === 'sms' || input.mode === 'both') {
    deliveryParts.push(`Delivered to in-app ${input.recipientCarrier} Phone Receiver`);
  }
  if (input.mode === 'voice' || input.mode === 'both') {
    deliveryParts.push(`Voice call ring & IVR *180*${input.ivrCode}# active on Phone Receiver`);
  }

  return {
    provider: 'local_relay',
    reference: refCode,
    status: 'delivered_relay',
    note: deliveryParts.join(' · '),
  };
}
