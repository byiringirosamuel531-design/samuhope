export type UserRole = 'user' | 'admin';
export type UserStatus = 'active' | 'suspended';
export type DeliveryMode = 'sms' | 'voice' | 'both';
export type ReceiverDeviceMode = 'feature' | 'smartphone' | 'tablet';
export type CallStatus = 'ringing' | 'active' | 'ended' | 'declined' | 'missed';
export type MessageStatus = 'delivered_gateway' | 'delivered_relay' | 'queued' | 'failed' | 'cancelled';

export interface CallRecord {
  id: string;
  callerId: string;
  callerName: string;
  callerPhone: string;
  recipientPhone: string;
  recipientCarrier: string;
  targetDevice: ReceiverDeviceMode;
  status: CallStatus;
  provider: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  durationSec: number;
}

export interface UserProfile {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  carrier: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
  messageCount?: number;
}

export interface MessageRecord {
  id: string;
  senderId: string;
  senderName: string;
  senderPhone: string;
  recipientPhone: string;
  recipientCarrier: string;
  mode: DeliveryMode;
  textBody: string;
  smsSegments: number;
  audioUrl: string | null;
  audioDurationSec: number;
  audioMimeType: string | null;
  gatewayProvider: string;
  gatewayReference: string;
  status: MessageStatus;
  deliveryNote: string;
  ivrCode: string;
  createdAt: string;
}

export interface ActivityLog {
  id: string;
  userId: string | null;
  userName: string;
  userEmail: string;
  action: string;
  targetType: string;
  targetId: string;
  details: string;
  createdAt: string;
}

export interface GatewayStatusInfo {
  activeProvider: 'pindo' | 'africas_talking' | 'twilio' | 'http_gateway' | 'local_relay';
  pindoConfigured: boolean;
  africasTalkingConfigured: boolean;
  twilioConfigured: boolean;
  httpGatewayConfigured: boolean;
  appUrl: string;
}

export interface AdminOverview {
  totalUsers: number;
  activeUsers: number;
  suspendedUsers: number;
  totalMessages: number;
  voiceMessages: number;
  smsMessages: number;
  mtnMessages: number;
  airtelMessages: number;
  gateway: GatewayStatusInfo;
}
