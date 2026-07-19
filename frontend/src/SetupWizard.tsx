/**
 * The first-run wizard (Haven fork, 19 Jul 2026 brief).
 *
 * A virgin install boots here instead of the front door: the Worker serves the
 * shell with every other API closed, and this component walks the minimum path
 * Elle ruled (Option B) — app password → Anthropic key → identity (names,
 * static prompt paste, optional ElevenLabs voice) → done. Everything else is a
 * Fuse Box circuit flipped when its owner is ready; the last screen says so.
 *
 * One atomic completion call: /api/setup/complete writes password last, so a
 * failure anywhere leaves the install virgin and this wizard retryable. The
 * form surfaces are the Fuse Box's field/button vocabulary re-sequenced — no
 * new design language.
 */

import { useState } from 'react';
import { api } from './api';

type Step = 'welcome' | 'password' | 'key' | 'identity' | 'done';

const browserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

export function SetupWizard() {
  const [step, setStep] = useState<Step>('welcome');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [keyChecked, setKeyChecked] = useState<string | null>(null);
  const [houseName, setHouseName] = useState('Haven OS');
  const [companionName, setCompanionName] = useState('');
  const [userName, setUserName] = useState('');
  const [timezone, setTimezone] = useState(browserTimezone());
  const [staticPrompt, setStaticPrompt] = useState('');
  const [voiceId, setVoiceId] = useState('');

  async function testKey() {
    setBusy(true);
    setError(null);
    setKeyChecked(null);
    try {
      const res = await api('/setup/test-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ anthropic_key: anthropicKey }),
      });
      const data = (await res.json()) as { ok: boolean; detail?: string; error?: string };
      if (data.ok) setKeyChecked(data.detail ?? 'The key works.');
      else setError(data.detail ?? data.error ?? 'The key test failed.');
    } catch {
      setError("Couldn't reach the setup API — is the Worker deployed?");
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    setBusy(true);
    setError(null);
    try {
      const res = await api('/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          password,
          anthropic_key: anthropicKey,
          house_name: houseName,
          companion_name: companionName,
          user_name: userName,
          timezone,
          static_prompt: staticPrompt,
          voice_id: voiceId || undefined,
        }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (data.ok) setStep('done');
      else setError(data.error ?? 'Setup failed — nothing was finalised; try again.');
    } catch {
      setError("Couldn't reach the setup API — nothing was finalised; try again.");
    } finally {
      setBusy(false);
    }
  }

  const stepIndex = ['welcome', 'password', 'key', 'identity', 'done'].indexOf(step);

  return (
    <div className="wizard">
      <div className="wizard__card">
        <div className="wizard__progress" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={`wizard__dot ${i <= stepIndex ? 'wizard__dot--on' : ''}`} />
          ))}
        </div>

        {step === 'welcome' && (
          <>
            <h1 className="wizard__title">Welcome home</h1>
            <p className="wizard__text">
              This house is empty — let's move you in. Three things and the front
              door works: a password, an Anthropic key, and who lives here.
              Everything else can wait.
            </p>
            <button className="wizard__go" onClick={() => setStep('password')}>
              Begin
            </button>
          </>
        )}

        {step === 'password' && (
          <>
            <h1 className="wizard__title">The front-door key</h1>
            <p className="wizard__text">
              One password unlocks the whole house. At least 8 characters — a
              password manager's suggestion is perfect. It can't be recovered,
              only reset by re-running setup against a fresh database, so keep it
              somewhere safe.
            </p>
            <label className="wizard__field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <label className="wizard__field">
              <span>Again, to be sure</span>
              <input
                type="password"
                value={password2}
                autoComplete="new-password"
                onChange={(e) => setPassword2(e.target.value)}
              />
            </label>
            <button
              className="wizard__go"
              disabled={password.length < 8 || password !== password2}
              onClick={() => {
                setError(null);
                setStep('key');
              }}
            >
              {password && password2 && password !== password2
                ? "They don't match yet"
                : 'Next'}
            </button>
          </>
        )}

        {step === 'key' && (
          <>
            <h1 className="wizard__title">The voice on the wire</h1>
            <p className="wizard__text">
              The Anthropic API key is how your companion thinks and speaks —
              it's the one key the house can't open without. Paste it here; you
              can test it before moving on.
            </p>
            <label className="wizard__field">
              <span>Anthropic API key</span>
              <input
                type="password"
                value={anthropicKey}
                autoComplete="off"
                placeholder="sk-ant-…"
                onChange={(e) => {
                  setAnthropicKey(e.target.value);
                  setKeyChecked(null);
                }}
              />
            </label>
            {keyChecked && <p className="wizard__ok">{keyChecked}</p>}
            <div className="wizard__row">
              <button
                className="wizard__test"
                disabled={busy || !anthropicKey.trim()}
                onClick={() => void testKey()}
              >
                {busy ? 'Testing…' : 'Test the key'}
              </button>
              <button
                className="wizard__go"
                disabled={!anthropicKey.trim()}
                onClick={() => {
                  setError(null);
                  setStep('identity');
                }}
              >
                Next
              </button>
            </div>
          </>
        )}

        {step === 'identity' && (
          <>
            <h1 className="wizard__title">Who lives here</h1>
            <p className="wizard__text">
              The names every surface will use, and the companion's own prompt —
              paste the identity you've written. You know what you're doing;
              nothing here is templated over your words.
            </p>
            <label className="wizard__field">
              <span>House name</span>
              <input value={houseName} onChange={(e) => setHouseName(e.target.value)} />
            </label>
            <div className="wizard__pair">
              <label className="wizard__field">
                <span>Companion's name</span>
                <input
                  value={companionName}
                  placeholder="who answers"
                  onChange={(e) => setCompanionName(e.target.value)}
                />
              </label>
              <label className="wizard__field">
                <span>Your name</span>
                <input
                  value={userName}
                  placeholder="who they answer to"
                  onChange={(e) => setUserName(e.target.value)}
                />
              </label>
            </div>
            <label className="wizard__field">
              <span>Timezone</span>
              <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </label>
            <label className="wizard__field">
              <span>The companion's prompt</span>
              <textarea
                className="wizard__prompt"
                value={staticPrompt}
                placeholder="Paste the full identity prompt — who they are, how they speak, what they know."
                onChange={(e) => setStaticPrompt(e.target.value)}
              />
            </label>
            <label className="wizard__field">
              <span>ElevenLabs voice ID (optional — voice can wait)</span>
              <input
                value={voiceId}
                placeholder="skippable"
                onChange={(e) => setVoiceId(e.target.value)}
              />
            </label>
            <button
              className="wizard__go"
              disabled={
                busy ||
                !companionName.trim() ||
                !userName.trim() ||
                !houseName.trim() ||
                !staticPrompt.trim()
              }
              onClick={() => void complete()}
            >
              {busy ? 'Moving you in…' : 'Finish setup'}
            </button>
          </>
        )}

        {step === 'done' && (
          <>
            <h1 className="wizard__title">The lights are on</h1>
            <p className="wizard__text">
              {companionName || 'Your companion'} can talk. Everything else —
              the other keys, the smart-home rosters, Workshop blocks, reference
              images, a memory seed, the décor — lives in the Fuse Box, behind
              the same password, ready whenever you are. Flip circuits at your
              own pace; nothing is waiting on a deploy.
            </p>
            <button className="wizard__go" onClick={() => location.reload()}>
              Open the front door
            </button>
          </>
        )}

        {error && <p className="wizard__err">{error}</p>}
      </div>
    </div>
  );
}
