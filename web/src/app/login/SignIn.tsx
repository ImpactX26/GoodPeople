"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Bike,
  Check,
  CircleAlert,
  HandPlatter,
  House,
  LoaderCircle,
  MapPinned,
  type LucideIcon,
} from "lucide-react";
import { Counter, type IntroPhase, Heading, Leader, Masthead, PrintIn, Rule, Ticket, TicketMeta, stamp } from "@/components/ticket/Ticket";
import { introOwed, markIntroSeen } from "@/lib/luna/intro";
import LunaMark, { type MarkState } from "@/components/brand/LunaMark";
import {
  OTP_LENGTH,
  RESEND_AFTER_S,
  completeProfile,
  formatPhone,
  getProfile,
  getSession,
  isValidPhone,
  requestOtp,
  verifyOtp,
} from "@/lib/luna/auth";
import { ROLES, ROLE_META, type DetailField, type Role } from "@/lib/luna/roles";
import { useHydrated } from "@/lib/luna/useHydrated";
import s from "./signin.module.css";
import { listNgos } from "@/lib/luna/ngoAgent";

type Step = "role" | "phone" | "code" | "details" | "done";

const ROLE_ICON: Record<Role, LucideIcon> = {
  donor: HandPlatter,
  ngo: House,
  volunteer: Bike,
  admin: MapPinned,
};


export default function SignIn() {
  const router = useRouter();
  const hydrated = useHydrated();
  // Decide once, at load, whether this visit still owes the logo intro.
  const owed = useMemo(() => !hydrated || introOwed(), [hydrated]);
  const [phase, setPhase] = useState<IntroPhase>("feed");
  const intro: IntroPhase = owed ? phase : "done";
  const [kotNumber] = useState(() => 1000 + Math.floor(Math.random() * 9000));
  const kot = hydrated ? String(kotNumber) : "";

  const [step, setStep] = useState<Step>("role");
  const [role, setRole] = useState<Role | null>(null);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [resendIn, setResendIn] = useState(0);
  const [locked, setLocked] = useState(false);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [welcomeName, setWelcomeName] = useState("");
  const [tearing, setTearing] = useState(false);

  useEffect(() => {
    const session = getSession();
    if (session) {
      router.replace(`/${session.role}`);
      return;
    }
  }, [router]);

  useEffect(() => {
    if (!hydrated || !owed) return;
    markIntroSeen();
    const at = (ms: number, next: IntroPhase) =>
      setTimeout(() => setPhase((p) => (p === "done" ? p : next)), ms);
    const timers = [at(1550, "roll"), at(2650, "reveal"), at(4550, "done")];
    return () => timers.forEach(clearTimeout);
  }, [hydrated, owed]);

  // Resend countdown
  useEffect(() => {
    if (resendIn <= 0) return;
    const id = setTimeout(() => setResendIn((n) => n - 1), 1000);
    return () => clearTimeout(id);
  }, [resendIn]);

  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };

  const chooseRole = (r: Role) => {
    setRole(r);
    go("phone");
  };

  const sendCode = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!role) return;
    if (!isValidPhone(phone)) {
      setError(
        phone.length < 10
          ? "Enter all 10 digits of your mobile number."
          : "Indian mobile numbers start with 6, 7, 8 or 9. Check the first digit.",
      );
      return;
    }
    setBusy(true);
    setError(null);
    let res: Awaited<ReturnType<typeof requestOtp>>;
    try {
      res = await requestOtp(role, phone);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Couldn\u2019t send the code. Try again.");
      return;
    }
    setBusy(false);
    setDevCode(res.devCode ?? null);
    setCode("");
    setLocked(false);
    setExpiresAt(res.expiresAt);
    setResendIn(RESEND_AFTER_S);
    go("code");
  };

  const finishWith = useCallback((name: string) => {
    setWelcomeName(name);
    go("done");
  }, []);

  const checkCode = useCallback(
    async (value: string) => {
      if (!role || value.length !== OTP_LENGTH || busy) return;
      setBusy(true);
      setError(null);
      let res: Awaited<ReturnType<typeof verifyOtp>>;
      try {
        res = await verifyOtp(role, phone, value);
      } catch (err) {
        setBusy(false);
        setCode("");
        setError(err instanceof Error ? err.message : "Couldn\u2019t check the code. Try again.");
        return;
      }
      setBusy(false);
      if (res.ok) {
        if (res.isNew) go("details");
        else finishWith(getProfile(role, phone)?.fields.name ?? "");
        return;
      }
      setCode("");
      if (res.reason === "mismatch") {
        setError(
          `That code didn’t match. ${res.attemptsLeft} ${res.attemptsLeft === 1 ? "try" : "tries"} left.`,
        );
      } else if (res.reason === "locked") {
        setLocked(true);
        setResendIn(0);
        setError("Too many wrong tries. Get a new code to try again.");
      } else if (res.reason === "expired") {
        setLocked(true);
        setResendIn(0);
        setError("This code has expired. Get a new one.");
      } else {
        setLocked(true);
        setResendIn(0);
        setError("We couldn’t find a code for this number. Get a new one.");
      }
    },
    [role, phone, busy, finishWith],
  );

  // Once the welcome line prints, tear the ticket off.
  useEffect(() => {
    if (step !== "done") return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = setTimeout(() => (reduce ? router.replace(`/${role}`) : setTearing(true)), reduce ? 400 : 1900);
    return () => clearTimeout(id);
  }, [step, role, router]);

  const meta = role ? ROLE_META[role] : null;

  return (
    <>
      <Counter busy={busy || step === "done" || intro !== "done"} intro={intro}>
        <Ticket label="Sign in to Luna" tearing={tearing} onTorn={() => router.replace(`/${role}`)}>
          <Masthead intro={intro} />
          <div className={s.rest} data-open={intro === "done"} data-animate={owed}>
          <p className={s.tagline}>Surplus food to people who need it, before it goes bad.</p>
          <Rule />
          <TicketMeta left={kot ? `KOT ${kot} · BLR` : "KOT · BLR"} />
          <Rule solid />

          {/* Everything already decided stays printed on the ticket. */}
          {step !== "role" && meta && (
            <div className={s.printed}>
              <Leader
                label="Signing in as"
                value={meta.label}
                action={
                  step === "phone" || step === "code"
                    ? { label: "Change", onClick: () => go("role"), a11y: "Change role" }
                    : undefined
                }
              />
              {(step === "code" || step === "details" || step === "done") && (
                <Leader
                  label="Mobile"
                  value={formatPhone(phone)}
                  action={
                    step === "code"
                      ? { label: "Change", onClick: () => go("phone"), a11y: "Change mobile number" }
                      : undefined
                  }
                />
              )}
              {(step === "details" || step === "done") && (
                <Leader
                  label="Verified"
                  value={
                    <span className={s.verified}>
                      <Check size={14} strokeWidth={3} aria-hidden="true" /> OK
                    </span>
                  }
                />
              )}
            </div>
          )}

          <div aria-live="polite" className={s.stepSlot}>
            {step === "role" && (
              <PrintIn key="role" lines={9}>
                <Heading>Who&rsquo;s signing in?</Heading>
                <ul className={s.roles}>
                  {ROLES.map((r) => {
                    const Icon = ROLE_ICON[r];
                    return (
                      <li key={r}>
                        <button type="button" className={s.role} onClick={() => chooseRole(r)}>
                          <Icon className={s.roleIcon} size={22} strokeWidth={1.75} aria-hidden="true" />
                          <span className={s.roleText}>
                            <span className={s.roleName}>{ROLE_META[r].label}</span>
                            <span className={s.roleWho}>{ROLE_META[r].who}</span>
                          </span>
                          <ArrowRight className={s.roleArrow} size={18} aria-hidden="true" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </PrintIn>
            )}

            {step === "phone" && (
              <PrintIn key="phone" lines={6}>
                <form onSubmit={sendCode} noValidate>
                  <Heading>
                    <label htmlFor="phone">Your mobile number</label>
                  </Heading>
                  <div className={s.phoneBox} data-invalid={!!error}>
                    <span className={s.prefix} aria-hidden="true">
                      +91
                    </span>
                    <input
                      id="phone"
                      className={s.phoneInput}
                      type="tel"
                      inputMode="numeric"
                      autoComplete="tel-national"
                      autoFocus
                      placeholder="98450 12345"
                      value={phone.length > 5 ? `${phone.slice(0, 5)} ${phone.slice(5)}` : phone}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, "").replace(/^91(?=\d{10}$)/, "").slice(0, 10);
                        setPhone(digits);
                        if (error) setError(null);
                      }}
                      aria-describedby="phone-note phone-error"
                      aria-invalid={!!error}
                    />
                  </div>
                  <Problem id="phone-error" message={error} />
                  <p id="phone-note" className={s.note}>
                    We&rsquo;ll text a 6-digit code to this number.{" "}
                    {role === "donor" ? "The delivery partner and NGO coming for your food will also call you on it."
                      : role === "volunteer" ? "Restaurants and NGOs on your pickups can call you on it."
                      : role === "ngo" ? "Restaurants and your volunteers can call you on it." : ""}
                  </p>
                  <PrimaryButton busy={busy} busyLabel="Sending code">
                    Send code
                  </PrimaryButton>
                </form>
              </PrintIn>
            )}

            {step === "code" && (
              <PrintIn key="code" lines={8}>
                <CodeStep
                  code={code}
                  setCode={(v) => {
                    setCode(v);
                    if (error && !locked) setError(null);
                    if (v.length === OTP_LENGTH) void checkCode(v);
                  }}
                  busy={busy}
                  locked={locked}
                  error={error}
                  expiresAt={expiresAt}
                  resendIn={resendIn}
                  devCode={devCode}
                  onResend={() => void sendCode()}
                />
              </PrintIn>
            )}

            {step === "details" && role && (
              <PrintIn key="details" lines={10}>
                <DetailsStep
                  role={role}
                  busy={busy}
                  serverError={saveError}
                  onSubmit={async (fields) => {
                    setBusy(true);
                    setSaveError(null);
                    try {
                      await completeProfile(role, phone, fields);
                    } catch (err) {
                      setBusy(false);
                      setSaveError(err instanceof Error ? err.message : "Couldn\u2019t save. Try again.");
                      return;
                    }
                    setBusy(false);
                    finishWith(fields.name);
                  }}
                />
              </PrintIn>
            )}

            {step === "done" && meta && (
              <PrintIn key="done" lines={4}>
                <Rule />
                <MatchedMark />
                <p className={s.welcome}>
                  {welcomeName ? `Welcome, ${welcomeName.split(" ")[0]}.` : "Welcome back."}
                </p>
                <p className={`${s.note} ${s.center}`}>Opening your {role === "ngo" ? "NGO" : meta.label.toLowerCase()} app&hellip;</p>
              </PrintIn>
            )}
          </div>

          <Rule />
          <footer className={s.footer}>
            <span className={s.barcode} aria-hidden="true" />
            <span>Bengaluru pilot</span>
          </footer>
          </div>
        </Ticket>
      </Counter>
      {intro !== "done" && (
        <button type="button" className={s.skipIntro} onClick={() => setPhase("done")}>
          Skip
        </button>
      )}
    </>
  );
}

/* ---------- Pieces ---------- */

/** Signed in: the two halves close and the empty one fills. Matched. */
function MatchedMark() {
  const [state, setState] = useState<MarkState>("logo");
  useEffect(() => {
    const id = setTimeout(() => setState("joined"), 220);
    return () => clearTimeout(id);
  }, []);
  return (
    <div className={s.matched}>
      <LunaMark size={84} state={state} title="Signed in" />
    </div>
  );
}

function Problem({ id, message }: { id: string; message: string | null }) {
  return (
    <p id={id} className={s.problem} role={message ? "alert" : undefined}>
      {message && (
        <>
          <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
          <span>{message}</span>
        </>
      )}
    </p>
  );
}

function PrimaryButton({
  children,
  busy,
  busyLabel,
  disabled,
}: {
  children: string;
  busy: boolean;
  busyLabel: string;
  disabled?: boolean;
}) {
  return (
    <button type="submit" className={s.primary} disabled={disabled || busy} aria-busy={busy}>
      {busy ? (
        <>
          <span>{busyLabel}</span>
          <LoaderCircle className={s.spin} size={18} aria-hidden="true" />
        </>
      ) : (
        <>
          <span>{children}</span>
          <ArrowRight size={18} strokeWidth={2.25} aria-hidden="true" />
        </>
      )}
    </button>
  );
}

function CodeStep({
  code,
  setCode,
  busy,
  locked,
  error,
  expiresAt,
  resendIn,
  devCode,
  onResend,
}: {
  code: string;
  setCode: (v: string) => void;
  busy: boolean;
  locked: boolean;
  error: string | null;
  expiresAt: number;
  resendIn: number;
  devCode: string | null;
  onResend: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const expires = expiresAt ? stamp(new Date(expiresAt)).split("  ")[1] : "";

  useEffect(() => {
    if (!locked) inputRef.current?.focus();
  }, [locked]);

  return (
    <div>
      <Heading>
        <label htmlFor="otp">Enter the 6-digit code</label>
      </Heading>
      <div className={s.otp} data-invalid={!!error} data-disabled={locked || busy}>
        <input
          ref={inputRef}
          id="otp"
          className={s.otpInput}
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={OTP_LENGTH}
          value={code}
          disabled={locked || busy}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, OTP_LENGTH))}
          aria-describedby="otp-note otp-error"
          aria-invalid={!!error}
        />
        {Array.from({ length: OTP_LENGTH }, (_, i) => (
          <span
            key={i}
            className={s.cell}
            data-filled={i < code.length}
            data-active={focused && !busy && (i === code.length || (i === OTP_LENGTH - 1 && code.length === OTP_LENGTH))}
            aria-hidden="true"
          >
            {code[i] ?? ""}
          </span>
        ))}
      </div>
      <Problem id="otp-error" message={error} />
      <p id="otp-note" className={s.note}>
        {busy ? (
          <span className={s.checking}>
            <LoaderCircle className={s.spin} size={15} aria-hidden="true" /> Checking the code&hellip;
          </span>
        ) : locked ? (
          "Tap below to get a new code."
        ) : (
          <>Sent just now. It works until {expires}.</>
        )}
      </p>

      <div className={s.resendRow}>
        {resendIn > 0 ? (
          <span className={s.resendWait}>
            Resend code in 0:{String(resendIn).padStart(2, "0")}
          </span>
        ) : (
          <button type="button" className={locked ? s.primaryInline : s.linkButton} onClick={onResend} disabled={busy}>
            {locked ? "Get a new code" : "Resend code"}
          </button>
        )}
      </div>

      {devCode && !locked && (
        <aside className={s.devChit} aria-label="Developer code">
          <span className={s.devStamp}>Dev mode</span>
          <p className={s.devText}>
            No SMS is sent. Use <strong className={s.devCode}>{devCode}</strong>
          </p>
          <button
            type="button"
            className={s.devFill}
            disabled={busy}
            onClick={() => setCode(devCode)}
          >
            Fill it in
          </button>
        </aside>
      )}
    </div>
  );
}

function DetailsStep({
  role,
  busy,
  serverError,
  onSubmit,
}: {
  role: Role;
  busy: boolean;
  serverError: string | null;
  onSubmit: (fields: Record<string, string>) => void;
}) {
  const meta = ROLE_META[role];
  const [values, setValues] = useState<Record<string, string>>({});
  const [missing, setMissing] = useState<string[]>([]);
  const uid = useId();

  const set = (key: string, v: string) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    setMissing((m) => m.filter((k) => k !== key));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const gaps = meta.details
      .filter((f) => f.kind !== "ngo" && !(f.kind === "text" && f.optional) && !(values[f.key] ?? "").trim())
      .map((f) => f.key);
    if (gaps.length) {
      setMissing(gaps);
      document.getElementById(`${uid}-${gaps[0]}`)?.focus();
      return;
    }
    onSubmit(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()])));
  };

  return (
    <form onSubmit={submit} noValidate>
      <Heading>First time here</Heading>
      <p className={s.lede}>A few details, once. Takes about 20 seconds.</p>
      <div className={s.fields}>
        {meta.details.map((f) => (
          f.kind === "ngo"
            ? <NgoField key={f.key} field={f} id={`${uid}-${f.key}`} value={values[f.key] ?? ""} helps={values[f.helpsKey] === "yes"}
                onChange={(v) => { set(f.key, v); if (!v) set(f.helpsKey, ""); }} onHelps={(on) => set(f.helpsKey, on ? "yes" : "no")} />
            : <Field key={f.key} field={f} id={`${uid}-${f.key}`} value={values[f.key] ?? ""} onChange={(v) => set(f.key, v)} missing={missing.includes(f.key)} />
        ))}
      </div>
      <Problem id={`${uid}-error`} message={missing.length ? "Fill in the marked lines to finish." : serverError} />
      <PrimaryButton busy={busy} busyLabel="Saving">
        Finish sign-up
      </PrimaryButton>
    </form>
  );
}

/** Which NGO a delivery partner rides for (from the NGOs listed on Luna), and whether they'll help others too. */
function NgoField({ field, id, value, helps, onChange, onHelps }: {
  field: Extract<DetailField, { kind: "ngo" }>; id: string; value: string; helps: boolean; onChange: (v: string) => void; onHelps: (on: boolean) => void;
}) {
  const [ngos, setNgos] = useState<{ ngo_id: string; name: string }[] | null>(null);
  useEffect(() => { listNgos().then(setNgos, () => setNgos([])); }, []);
  return (
    <div className={s.field}>
      <label htmlFor={id} className={s.fieldLabel}>{field.label}</label>
      <select id={id} className={s.select} value={value} disabled={!ngos} onChange={(e) => onChange(e.target.value)}>
        <option value="">No NGO: I help anyone nearby</option>
        {(ngos ?? []).map((n) => <option key={n.ngo_id} value={n.ngo_id.replace(/^NGO-/, "")}>{n.name}</option>)}
      </select>
      {value && (
        <label className={s.choice} data-on={helps} style={{ marginTop: 10 }}>
          <input type="checkbox" checked={helps} onChange={(e) => onHelps(e.target.checked)} className={s.choiceRadio} />
          <span className={s.tick} aria-hidden="true">{helps && <Check size={12} strokeWidth={3.5} />}</span>
          Also deliver for other NGOs when they need help
        </label>
      )}
    </div>
  );
}

function Field({
  field,
  id,
  value,
  onChange,
  missing,
}: {
  field: DetailField;
  id: string;
  value: string;
  onChange: (v: string) => void;
  missing: boolean;
}) {
  if (field.kind === "text") {
    return (
      <div className={s.field} data-missing={missing}>
        <label htmlFor={id} className={s.fieldLabel}>
          {field.label}
        </label>
        <input
          id={id}
          className={s.textInput}
          type="text"
          autoComplete={field.key === "name" ? "name" : field.key === "org" ? "organization" : "off"}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={missing}
        />
      </div>
    );
  }

  if (field.kind === "ngo") return null;   // rendered by NgoField
  // Few options: printed tick boxes. Many (areas): a native picker.
  if (field.options.length <= 6) {
    return (
      <fieldset className={s.field} data-missing={missing} id={id} tabIndex={-1}>
        <legend className={s.fieldLabel}>{field.label}</legend>
        <div className={s.choices}>
          {field.options.map((opt) => (
            <label key={opt} className={s.choice} data-on={value === opt}>
              <input
                type="radio"
                name={id}
                value={opt}
                checked={value === opt}
                onChange={() => onChange(opt)}
                className={s.choiceRadio}
              />
              <span className={s.tick} aria-hidden="true">
                {value === opt && <Check size={12} strokeWidth={3.5} />}
              </span>
              {opt}
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  return (
    <div className={s.field} data-missing={missing}>
      <label htmlFor={id} className={s.fieldLabel}>
        {field.label}
      </label>
      <select id={id} className={s.select} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={missing}>
        <option value="" disabled>
          Choose your area
        </option>
        {field.options.map((opt) => (
          <option key={opt}>{opt}</option>
        ))}
      </select>
    </div>
  );
}
