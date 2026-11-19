import React, { useState } from 'react';
import { Eye, EyeOff, Lock, Mail, Mic, Phone, ShieldCheck, Smartphone, UserCheck } from 'lucide-react';
import { apiRequest, setStoredToken } from '../lib/api.ts';
import { parseRwandaPhone } from '../lib/rwandaPhone.ts';
import type { GatewayStatusInfo, UserProfile } from '../types.ts';

interface AuthScreenProps {
  onAuthenticated: (user: UserProfile, gateway?: GatewayStatusInfo) => void;
  onOpenReceiver: () => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({
  onAuthenticated,
  onOpenReceiver,
}) => {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [identifier, setIdentifier] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedRegPhone = parseRwandaPhone(phone);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (mode === 'register') {
      if (fullName.trim().length < 2) {
        setError('Please enter your full name.');
        return;
      }
      if (!parsedRegPhone.valid) {
        setError(parsedRegPhone.error || 'Enter a valid Rwandan mobile number.');
        return;
      }
      if (password.length < 6) {
        setError('Password must be at least 6 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    }

    setSubmitting(true);
    try {
      if (mode === 'login') {
        const res = await apiRequest<{
          token: string;
          user: UserProfile;
          gateway?: GatewayStatusInfo;
        }>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ identifier, password }),
        });
        setStoredToken(res.token);
        onAuthenticated(res.user, res.gateway);
      } else {
        const res = await apiRequest<{
          token: string;
          user: UserProfile;
          gateway?: GatewayStatusInfo;
        }>('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            fullName: fullName.trim(),
            email: email.trim(),
            phone: parsedRegPhone.e164,
            password,
          }),
        });
        setStoredToken(res.token);
        onAuthenticated(res.user, res.gateway);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="bg-white border-b border-slate-200 px-6 lg:px-10 h-16 flex items-center justify-between gap-8">
        <span className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
          KigaliRelay
        </span>
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
          <a href="#how-it-works" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
            How It Works
          </a>
          <a href="#carriers" className="hover:text-slate-900 transition-colors whitespace-nowrap shrink-0">
            Rwanda Carriers
          </a>
        </nav>
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={onOpenReceiver}
            className="px-4 py-2 text-sm font-medium text-teal-800 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            Phone &amp; Tablet Receiver
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-10 lg:py-16 grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
        {/* Left Informational Panel */}
        <section className="lg:col-span-6 space-y-8">
          <div className="space-y-4">
            <p className="text-xs font-medium text-teal-700 tracking-wide">
              Rwanda SMS &amp; Voice Dispatch · MTN 078/079 · Airtel 072/073
            </p>
            <h1 className="text-3xl lg:text-4xl font-bold tracking-tight text-slate-900 text-balance leading-tight">
              Reach any Rwandan phone number without requiring a smartphone
            </h1>
            <p className="text-base text-slate-600 leading-relaxed max-w-xl">
              Sign in or create an account to write text SMS messages and record voice audio directly
              from your computer. Recipients on standard button phones receive real SMS text and
              automated voice calls over MTN Rwanda and Airtel Rwanda networks.
            </p>
          </div>

          <div id="how-it-works" className="border-t border-slate-200 pt-6 space-y-5">
            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-white border border-slate-200 flex items-center justify-center shrink-0 text-teal-700">
                <UserCheck className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  01. Verified Account &amp; Rwandan Number Registration
                </h2>
                <p className="text-sm text-slate-600 mt-1">
                  Every sender registers with a valid +250 mobile number and password. All sign-ins
                  and dispatches are audited.
                </p>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-white border border-slate-200 flex items-center justify-center shrink-0 text-teal-700">
                <Mic className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  02. Compose Text &amp; Record Real Voice Audio
                </h2>
                <p className="text-sm text-slate-600 mt-1">
                  Write GSM SMS messages with segment counting and record live voice notes delivered
                  as an automated phone call or IVR callback (*180*Code#) to basic phones.
                </p>
              </div>
            </div>

            <div id="carriers" className="flex items-start gap-4">
              <div className="w-10 h-10 rounded-lg bg-white border border-slate-200 flex items-center justify-center shrink-0 text-teal-700">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  03. Full Administrator Activity &amp; Moderation Console
                </h2>
                <p className="text-sm text-slate-600 mt-1">
                  Administrators manage user accounts, suspend or activate access, listen to recorded
                  voice messages, and inspect every system event log.
                </p>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl p-5 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Smartphone className="w-5 h-5 text-slate-500 shrink-0" />
              <div>
                <p className="text-sm font-semibold text-slate-900">
                  Receiving messages on a phone or tablet?
                </p>
                <p className="text-xs text-slate-500">
                  Open the live receiver for any +250 number on a button phone, smartphone, or Wi-Fi tablet.
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onOpenReceiver}
              className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              Open Receiver
            </button>
          </div>
        </section>

        {/* Right Authentication Card */}
        <section className="lg:col-span-6">
          <div className="bg-white border border-slate-200 rounded-xl p-6 sm:p-8 shadow-sm">
            {/* Segmented Control */}
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg mb-6">
              <button
                type="button"
                onClick={() => {
                  setMode('login');
                  setError(null);
                }}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                  mode === 'login'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('register');
                  setError(null);
                }}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                  mode === 'register'
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Create Account
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              {mode === 'login' ? (
                <div>
                  <label htmlFor="login-identifier" className="block text-sm font-medium text-slate-700 mb-1.5">
                    Email or Rwandan Phone Number
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="login-identifier"
                      type="text"
                      required
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      placeholder="name@example.rw or 0788 123 456"
                      className="w-full pl-10 pr-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-teal-600"
                    />
                  </div>
                </div>
              ) : (
                <>
                  <div>
                    <label htmlFor="reg-name" className="block text-sm font-medium text-slate-700 mb-1.5">
                      Full Name
                    </label>
                    <input
                      id="reg-name"
                      type="text"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Jean Bosco Habimana"
                      className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-teal-600"
                    />
                  </div>

                  <div>
                    <label htmlFor="reg-email" className="block text-sm font-medium text-slate-700 mb-1.5">
                      Email Address
                    </label>
                    <div className="relative">
                      <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        id="reg-email"
                        type="email"
                        required
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        placeholder="bosco@example.rw"
                        className="w-full pl-10 pr-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-teal-600"
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label htmlFor="reg-phone" className="block text-sm font-medium text-slate-700">
                        Rwandan Mobile Number
                      </label>
                      {phone.trim().length > 0 && parsedRegPhone.valid && (
                        <span className="text-xs font-medium text-teal-700">
                          {parsedRegPhone.carrier} · {parsedRegPhone.formatted}
                        </span>
                      )}
                    </div>
                    <div className="relative">
                      <Phone className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                      <input
                        id="reg-phone"
                        type="tel"
                        required
                        value={phone}
                        onChange={(e) => setPhone(e.target.value)}
                        placeholder="+250 788 123 456 or 0788123456"
                        className="w-full pl-10 pr-3.5 py-2.5 text-sm font-mono bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-teal-600"
                      />
                    </div>
                    {phone.trim().length > 3 && !parsedRegPhone.valid && (
                      <p className="text-xs text-red-700 mt-1">{parsedRegPhone.error}</p>
                    )}
                  </div>
                </>
              )}

              <div>
                <label htmlFor="auth-password" className="block text-sm font-medium text-slate-700 mb-1.5">
                  Password
                </label>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="auth-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === 'register' ? 'Minimum 6 characters' : 'Enter your password'}
                    className="w-full pl-10 pr-10 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-teal-600"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {mode === 'register' && (
                <div>
                  <label htmlFor="auth-confirm" className="block text-sm font-medium text-slate-700 mb-1.5">
                    Confirm Password
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      id="auth-confirm"
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter password"
                      className="w-full pl-10 pr-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-600 focus:border-teal-600"
                    />
                  </div>
                </div>
              )}

              {error && (
                <div role="alert" className="p-3 text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg space-y-2">
                  <p>{error}</p>
                  {mode === 'login' && error.toLowerCase().includes('no account found') && (
                    <button
                      type="button"
                      onClick={() => {
                        setMode('register');
                        setError(null);
                        if (identifier.includes('@')) setEmail(identifier);
                      }}
                      className="text-xs font-semibold text-teal-800 hover:text-teal-900 underline underline-offset-4"
                    >
                      Switch to Create Account
                    </button>
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-2.5 px-4 text-sm font-semibold text-white bg-teal-700 hover:bg-teal-800 disabled:opacity-60 rounded-lg transition-colors cursor-pointer"
              >
                {submitting
                  ? mode === 'login'
                    ? 'Signing In...'
                    : 'Creating Account...'
                  : mode === 'login'
                    ? 'Sign In to Workspace'
                    : 'Create Account & Continue'}
              </button>
            </form>
          </div>
        </section>
      </main>
    </div>
  );
};
