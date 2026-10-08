"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Navigation, ShieldAlert } from "lucide-react";
import { api } from "@/lib/luna/api";
import { getSession, type Session } from "@/lib/luna/auth";
import { useHydrated } from "@/lib/luna/useHydrated";
import { useTrip } from "@/lib/luna/useTrip";
import { along, bearing, distance, pathLength, offlineCodeMatches, project, TRIP_CONFIG as C, TRIP_STATUS, tripTime, visibleTrip, type TripView } from "@/lib/luna/trip";
import TripMap from "./TripMap";
import { compressPhoto } from "@/lib/luna/photo";
import s from "./trip.module.css";

export default function DeliveryHub() {
  const hydrated = useHydrated(), router = useRouter(), params = useSearchParams();
  const session = hydrated ? getSession() : null;
  const id = params.get("id");
  useEffect(() => { if (hydrated && !session) router.replace("/login"); }, [hydrated, session, router]);
  if (!session) return <main className={s.empty}>Loading your deliveries…</main>;
  return id ? <ActiveTrip key={id} id={id} session={session} /> : <DeliveryList session={session} />;
}

function Header({ session, title, sample = false }: { session: Session; title: string; sample?: boolean }) {
  return <header className={s.bar}>
    <Link href={`/${session.role}`} aria-label="Back to home"><ArrowLeft size={22} /></Link>
    <Link href="/deliveries" className={s.brand}>LUNA <span>{title}</span></Link>
    {sample && <span className={s.sample}>Sample delivery</span>}
  </header>;
}

function DeliveryList({ session }: { session: Session }) {
  const [trips, setTrips] = useState<TripView[]>([]), [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false), [demo, setDemo] = useState(false), [now, setNow] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const data = await api<{ trips: TripView[] }>("/trips", { token: session.token });
        if (!cancelled) { setTrips(data.trips); setError(null); setLoaded(true); setNow(Date.now()); }
      } catch (e) { if (!cancelled) { setError((e as Error).message); setLoaded(true); } }
    };
    void refresh();
    void api<{ demoEnabled: boolean }>("/trips/config", { token: session.token }).then(v => { if (!cancelled) setDemo(v.demoEnabled); }).catch(() => {});
    const timer = setInterval(refresh, C.listPollMs);
    return () => { cancelled = true; clearInterval(timer); };
  }, [session.token]);
  const active = trips.filter(t => !!t.shareAcceptedAt && !t.closedAt && t.requestStatus !== "declined" && (session.role !== "volunteer" || t.requestStatus === "accepted"));
  const requests = trips.filter(t => session.role === "volunteer" && t.requestStatus === "pending" && t.requestDeadline > now);
  const offered = trips.filter(t => !t.shareAcceptedAt && !t.closedAt);
  const history = trips.filter(t => !!t.closedAt);
  return <main className={s.shell}>
    <Header session={session} title="Deliveries" />
    <div className={s.listPaper}>
      <h1>{session.role === "volunteer" ? "Your pickup runs" : "Your deliveries"}</h1>
      <p className={s.note}>Follow each delivery from acceptance to handover.</p>
      {demo && <Link href="/demo" className={s.demoLink}>Walk through the app from a restaurant listing <ArrowRight size={18} /></Link>}
      {error && <p role="alert" className={s.alert}>{error}</p>}
      {!loaded && <p>Loading deliveries…</p>}
      {loaded && !trips.length && !error && <p className={s.empty}>No deliveries yet. Food shares appear here as soon as the NGO accepts.</p>}
      {[["Restaurant listings", offered], ["Active deliveries", active], ["Pickup requests", requests], ["Completed runs", history]].map(([title, list]) => (list as TripView[]).length > 0 && <section key={title as string}>
        <h2>{title as string}</h2>
        {(list as TripView[]).map(t => <Link href={`/deliveries?id=${t.id}`} className={s.listRow} key={t.id}>
          <div>{t.sample && <span className={s.sampleInk}>Sample</span>}<strong>{t.pickupArea} → {t.dropArea}</strong>
            <span>{t.servings} servings · {t.food}</span><span>{!t.shareAcceptedAt ? "Waiting for NGO acceptance" : t.requestStatus === "finding_partner" ? "Finding a delivery partner" : t.requestStatus === "pending" ? "Waiting for the delivery partner to accept" : TRIP_STATUS[t.status]}</span></div>
          <ArrowRight size={22} />
        </Link>)}
      </section>)}

    </div>
  </main>;
}

export function ActiveTrip({ id, session }: { id: string; session: Session }) {
  const router = useRouter();
  const state = useTrip(id, session), { connected, pending, error } = state;
  const [busy, setBusy] = useState(false), [containers, setContainers] = useState(false);
  const [code, setCode] = useState(""), [noGps, setNoGps] = useState(false);
  const [now, setNow] = useState(0), [photo, setPhoto] = useState("");
  const trip = visibleTrip(state.trip, session.role, now);
  const [quantity, setQuantity] = useState<number | null>(null);
  const [received, setReceived] = useState<number | null>(null), [problem, setProblem] = useState("");
  const [checks, setChecks] = useState({ smellsNormal: false, noSpoilage: false, temperatureOkay: false, packagingOkay: false });
  const [voice, setVoice] = useState(false);
  const [driving, setDriving] = useState(false);
  const acceptanceKey = useRef<string | null>(null);
  const simulation = useRef<{ path: NonNullable<TripView["route"]>["path"]; progress: number; previousAt: number; revision: number; target: string } | null>(null);
  const liveState = useRef(state);
  useEffect(() => { liveState.current = state; });
  const partner = session.role === "volunteer";
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const simulationReady = !!trip?.route && !trip.route.preview && ["to_pickup", "to_drop"].includes(trip.status);
  useEffect(() => {
    if (!driving || !simulationReady) return;
    let sending = false;
    const timer = setInterval(async () => {
      const current = liveState.current.trip;
      if (sending || !current?.route || current.route.preview || !["to_pickup", "to_drop"].includes(current.status)) return;
      const route = current.route, at = Date.now();
      if (!simulation.current || simulation.current.revision !== current.routeRevision || simulation.current.target !== route.target) {
        simulation.current = { path: route.path, progress: current.location ? project(current.location, route.path).progressM : 0, previousAt: at - C.demoTickMs, revision: current.routeRevision, target: route.target };
      }
      const sim = simulation.current, length = pathLength(sim.path);
      sim.progress = Math.min(length, sim.progress + Math.min(C.demoTickMs * 2, at - sim.previousAt) / 1000 * C.demoSpeedMps * C.demoTimeScale);
      sim.previousAt = at;
      const p = sim.progress >= length ? current[route.target]! : along(sim.path, sim.progress);
      const heading = bearing(along(sim.path, Math.max(0, sim.progress - 5)), along(sim.path, Math.min(length, sim.progress + 5)));
      sending = true;
      try { await liveState.current.enqueue("sample-location", { point: { ...p, at, accuracyM: 5, speedMps: sim.progress >= length ? 0 : C.demoSpeedMps * C.demoTimeScale, heading: Number.isFinite(heading) ? heading : 0 } }); }
      catch (e) { liveState.current.setError((e as Error).message); setDriving(false); }
      finally { sending = false; }
    }, C.demoTickMs);
    return () => clearInterval(timer);
  }, [driving, simulationReady]);
  const expired = trip ? now >= trip.safeUntil : false;
  const kind = trip && ["to_drop", "at_drop"].includes(trip.status) ? "drop" : "pickup";
  const destination = trip?.[kind];
  const progress = trip?.route && trip.location ? project(trip.location, trip.route.path) : null;
  let stepIndex = 0, stepDistance = 0;
  if (trip?.route && progress) {
    for (let i = 0; i < trip.route.steps.length; i++) {
      stepDistance += trip.route.steps[i].distanceM;
      stepIndex = i;
      if (stepDistance >= progress.progressM) break;
    }
  }
  const step = trip?.route?.steps[stepIndex];
  const spokenInstruction = step?.instruction;
  useEffect(() => {
    if (!voice || !partner || !spokenInstruction || !window.speechSynthesis || trip?.routeError) return;
    const speech = new SpeechSynthesisUtterance(spokenInstruction); speech.lang = "en-IN";
    speechSynthesis.cancel(); speechSynthesis.speak(speech);
    return () => speechSynthesis.cancel();
  }, [voice, partner, spokenInstruction, trip?.routeError]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); state.setError(null);
    try { await fn(); } catch (e) { state.setError((e as Error).message); } finally { setBusy(false); }
  };
  if (!trip) return <main className={s.shell}><Header session={session} title="Delivery" /><div className={s.listPaper}>{error ? <p className={s.alert} role="alert">{error}</p> : <p>Loading the delivery…</p>}<Link href="/deliveries">All deliveries</Link></div></main>;
  const offered = !trip.shareAcceptedAt, finding = trip.requestStatus === "finding_partner" && !offered;
  const waiting = offered || finding || trip.requestStatus === "pending";
  const stale = !trip.location || now - trip.location.at > C.staleMs;
  const next = { assigned: "Head to the pickup", to_pickup: "Arrive and ask the donor for the pickup code", at_pickup: "Verify the pickup code", picked_up: "Check the food and take a photo", to_drop: "Arrive and ask the NGO for the drop code", at_drop: "Verify the drop code to complete the delivery", delivered: "The NGO has received the food", held: "Contact the Luna team before continuing", failed_at_pickup: "Leave unsafe food with the donor" }[trip.status];

  return <main className={s.shell}>
    <Header session={session} title="Live delivery" sample={trip.sample} />
    <div className={s.tripLayout}>
      <section className={s.mapSection}>
        {trip.shareAcceptedAt && (trip.pickup || trip.drop) ? <TripMap trip={trip} partner={partner} />
          : <div className={s.mapWait}><Navigation size={40} /><p>{offered ? "The map opens when the NGO accepts this restaurant listing." : waiting ? "Accept this pickup to open navigation." : "This delivery has ended."}</p></div>}
        <div className={s.mapFooter}>
          <span>{connected ? "Connected to Luna" : "Reconnecting to Luna"}{pending > 0 ? ` · ${pending} updates waiting to sync` : ""}</span>
          {trip.sample && <span>Demo · OpenStreetMap streets, OSRM road routing · no live traffic</span>}
          {trip.route?.recordedAt && <span>Recorded road geometry · live demo router unavailable</span>}
          {trip.route?.preview && <span>Route preview · live partner tracking starts after partner acceptance.</span>}
          {trip.locationVisible && <span>{stale ? "Location delayed" : "GPS location"}{trip.location ? ` · last fix ${tripTime(trip.location.at)}` : " · waiting for a fix"}</span>}
          {!trip.locationVisible && trip.pickedUpAt && session.role === "donor" && !trip.closedAt && <span>Location sharing ended 10 minutes after pickup. Delivery status continues below.</span>}
        </div>
      </section>
      <aside className={s.slip}>
        <div className={s.ticketMeta}><span>{trip.sample ? "Sample trip" : "Delivery leg"}</span><span>{id.slice(-8).toUpperCase()}</span></div>
        <h1>{offered ? "Restaurant listing" : finding ? "Finding your delivery partner" : waiting ? "Pickup request" : TRIP_STATUS[trip.status]}</h1>
        <p className={s.note}>{trip.partnerName} · {trip.vehicle.replaceAll("_", " ")}</p>
        <div className={s.food}><strong>{trip.food}</strong><span>{trip.servings} servings · Grade {trip.grade}{trip.unsure ? " · food check required" : ""}</span><span className={expired ? s.expired : ""}>Safe until {tripTime(trip.safeUntil)}</span></div>
        {expired && !trip.closedAt && <p className={s.alert} role="alert">This food has passed its safe-until time. Stop and contact the Luna team.</p>}
        {error && <p className={s.alert} role="alert">{error}</p>}
        {waiting ? <>
          <div className={s.stops}><p><b>Pickup</b> {trip.pickupArea}</p><p><b>Drop</b> {trip.dropArea}</p></div>
          <p className={s.note}>Collect by {tripTime(trip.collectBy)}. Reply by {tripTime(trip.requestDeadline)}.</p>
          <p className={s.note}>Bring: {trip.containers}</p>
          {offered && session.role === "ngo" && <Link className={s.back} href="/offers">Review and accept your food offer →</Link>}
          {offered && session.role === "donor" && <p className={s.note}>Your food is listed. Waiting for the NGO to accept.</p>}
          {partner && trip.requestStatus === "pending" && <>
            {trip.partnerBringsContainers && <label className={s.check}><input type="checkbox" checked={containers} onChange={e => setContainers(e.target.checked)} />I have the containers</label>}
            <button disabled={busy || trip.partnerBringsContainers && !containers || now > trip.requestDeadline} onClick={() => void run(async () => {
              if (!trip.sample) state.enableGps();
              acceptanceKey.current ??= crypto.randomUUID();
              const value = await api<TripView>(`/partner/requests/${id}/accept`, { method: "POST", token: session.token, headers: { "Idempotency-Key": acceptanceKey.current }, body: JSON.stringify({ hasContainers: containers }) });
              state.apply(value); void state.refresh().catch(e => state.setError((e as Error).message));
            })}>Accept pickup</button>
            <button className={s.outline} disabled={busy} onClick={() => void run(async () => {
              await api(`/partner/requests/${id}/decline`, { method: "POST", token: session.token, headers: { "Idempotency-Key": crypto.randomUUID() }, body: "{}" }); router.replace("/volunteer");
            })}>Can’t take this pickup</button>
          </>}
          {!partner && !offered && <p className={s.note}>{finding ? "Your NGO has accepted. A delivery partner is being selected." : "Waiting for the delivery partner to accept."}</p>}
          {trip.routeError && <p className={s.note}>{trip.routeError}</p>}
          {trip.route && <p className={s.note}>Pickup → NGO · {(trip.route.distanceM / 1000).toFixed(1)} km by road · route preview</p>}
        </> : trip.requestStatus === "declined" ? <p>The delivery partner declined this request.</p> : <>
          <div className={s.stops}><p><b>Pickup</b> {trip.pickup?.name ?? trip.pickupArea}</p><p><b>Drop</b> {trip.drop?.name ?? trip.dropArea}</p></div>
          {!trip.closedAt && trip.eta && <div className={s.eta}><strong>{tripTime(trip.eta)}</strong><span>Estimated arrival at the {kind}</span></div>}
          {!trip.closedAt && destination && <div className={s.destination}><h2>{kind === "pickup" ? "Pickup address" : "Drop address"}</h2><p>{destination.address}</p>{destination.notes && <p className={s.note}>{destination.notes}</p>}</div>}
          {trip.routeError && <p className={s.note}>{trip.routeError}</p>}
          {partner && !trip.closedAt && <>
            {!state.gpsEnabled && !trip.sample && <button disabled={busy} onClick={state.enableGps}>Enable live location</button>}
            {state.gpsError && <p className={s.alert}>{state.gpsError}</p>}
            {!trip.sample && <p className={s.note}>Keep this page open during your run so location can update. Your phone may pause tracking when locked or when you switch apps.</p>}
            {step && ["to_pickup", "to_drop"].includes(trip.status) && <div className={s.direction}>
              <Navigation size={24} /><div><strong>{Math.max(0, Math.round(stepDistance - (progress?.progressM ?? 0)))} m</strong><p>{step.instruction}</p></div>
            </div>}
            {trip.route && <>
              <label className={s.check}><input type="checkbox" checked={voice} onChange={e => setVoice(e.target.checked)} />Speak directions</label>
              <details><summary>All directions · {(trip.route.distanceM / 1000).toFixed(1)} km</summary><ol className={s.directions}>{trip.route.steps.map((step, i) => <li key={i}>{step.instruction}</li>)}</ol></details>
              {trip.route.warnings.map((warning, i) => <p key={i} className={s.note}>{warning}</p>)}
            </>}
            {["to_pickup", "to_drop"].includes(trip.status) && <button disabled={busy || expired} onClick={() => void run(() => state.enqueue("arrived", { kind }, kind === "pickup" ? "at_pickup" : "at_drop"))}>I’m here</button>}
            {["at_pickup", "at_drop"].includes(trip.status) && <form onSubmit={e => {
              e.preventDefault(); void run(async () => {
                if (!connected || !navigator.onLine) {
                  const local = state.cache.current.trip?.offlineCodes?.[kind];
                  if (!local) throw new Error("Reconnect once to prepare offline handover codes.");
                  if (state.cache.current.codeTries[kind] >= C.codeTries) throw new Error("Offline code entry is locked. Reconnect for a Luna team review.");
                  if (!await offlineCodeMatches(local.salt, local.hash, code)) {
                    state.cache.current.codeTries[kind]++;
                    await state.enqueue("code", { kind, code, point: noGps ? null : state.raw.current });
                    throw new Error("Incorrect code. This attempt will be checked when you reconnect.");
                  }
                }
                const point = noGps ? null : state.raw.current;
                if (!point && !noGps) throw new Error("Enable GPS or choose to continue without GPS.");
                if (point && ((now || Date.now()) - point.at > C.staleMs || point.accuracyM > C.maxAccuracyM)) throw new Error("Wait for a fresh, accurate GPS fix.");
                if (point && destination && distance(point, destination) > C.codeGeofenceM) throw new Error("Enter the code within 300 metres of the handover point.");
                await state.enqueue("code", { kind, code, point }, kind === "pickup" ? "picked_up" : "delivered"); setCode("");
              });
            }}>
              <h2>Ask {kind === "pickup" ? "the donor" : "the NGO"} for the {kind} code</h2>
              <label>4-digit code<input autoComplete="off" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ""))} /></label>
              <label className={s.check}><input type="checkbox" checked={noGps} onChange={e => setNoGps(e.target.checked)} />GPS unavailable: continue and flag for review</label>
              <button disabled={busy || expired}>Verify {kind}</button>
            </form>}
            {trip.status === "picked_up" && <form onSubmit={e => { e.preventDefault(); void run(() => state.enqueue("pickup-check", { servings: quantity ?? trip.servings, photo, ...checks }, "to_drop")); }}>
              <h2>Check the food before leaving</h2>
              <label>Servings received<input type="number" required min={0} max={trip.servings} value={quantity ?? trip.servings} onChange={e => setQuantity(Number(e.target.value))} /></label>
              <label>Pickup photo<input type="file" accept="image/*" capture="environment" required={!photo} onChange={async e => {
                const file = e.target.files?.[0]; if (!file) return;
                try { setPhoto(await compressPhoto(file)); } catch (e) { state.setError((e as Error).message); }
              }} /></label>
              {photo && <p className={s.note}>Pickup photo ready.</p>}
              {([["smellsNormal", "Smells normal"], ["noSpoilage", "No mould, sliminess or discolouration"], ["temperatureOkay", "Hot food is warm / cold food is cold"], ["packagingOkay", "Packaging is closed and clean"]] as const).map(([key, label]) => <label className={s.check} key={key}><input type="checkbox" checked={checks[key]} onChange={e => setChecks(v => ({ ...v, [key]: e.target.checked }))} />{label}</label>)}
              <p className={s.note}>If any check fails, leave the food with the donor and report the failed pickup.</p>
              <button disabled={busy || !photo || expired}>{Object.values(checks).every(Boolean) ? "Food checked · head to drop" : "Report failed pickup"}</button>
            </form>}
            {trip.sample && ["to_pickup", "to_drop"].includes(trip.status) && destination && <div className={s.sampleControls}>
              <h2>Sample location controls</h2><p className={s.note}>These move the simulated partner on this sample delivery only.</p>
              <button disabled={busy} onClick={() => void run(async () => {
                if (driving) { setDriving(false); return; }
                if (!trip.location || trip.route?.preview) {
                  const start = kind === "pickup" ? { lat: destination.lat - .005, lng: destination.lng } : trip.pickup!;
                  await state.enqueue("sample-location", { point: { ...start, at: Date.now(), accuracyM: 5, speedMps: 0, heading: 0 } });
                }
                simulation.current = null; setDriving(true);
              })}>{driving ? "Pause demo ride" : "Play demo ride · 8× speed"}</button>
              {driving && !simulationReady && <p className={s.note}>Calculating the road route for the simulated rider…</p>}
              <button className={s.outline} disabled={busy} onClick={() => void run(() => state.enqueue("sample-location", { point: { ...destination, lat: destination.lat - 0.005, at: Date.now(), accuracyM: 5, speedMps: 0, heading: 0 } }))}>Sample · start near {kind}</button>
              <button className={s.outline} disabled={busy} onClick={() => void run(() => state.enqueue("sample-location", { point: { lat: destination.lat, lng: destination.lng, at: Date.now(), accuracyM: 5, speedMps: 0, heading: 0 } }))}>Sample · arrive at {kind}</button>
            </div>}
            {!trip.closedAt && <div className={s.assistance}>
              <button className={s.outline} disabled={busy} onClick={() => void run(() => state.enqueue("late", {}))}>Running late</button>
              <button className={s.sos} disabled={busy} onClick={() => void run(() => state.enqueue("sos", {}))}><ShieldAlert size={18} />Ask Luna for urgent help</button>
              <a href="tel:112">Call emergency services · 112</a>
            </div>}
          </>}
          {trip.code && <div className={s.codeHolder}><h2>Show this {trip.code.kind} code at handover</h2><strong>{trip.code.value}</strong><p className={s.note}>Share it with {trip.partnerName} when you hand over the food.</p></div>}
          {trip.status === "delivered" && <>
            {session.role === "ngo" && !trip.receipt && <form onSubmit={e => {
              e.preventDefault(); void run(async () => {
                const value = await api<TripView>(`/trips/${id}/receipt`, { method: "POST", token: session.token, headers: { "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ servings: received ?? trip.servings, problem }) }); state.apply(value);
              });
            }}><h2>Confirm food received</h2><label>Servings received<input type="number" required min={0} max={trip.servings} value={received ?? trip.servings} onChange={e => setReceived(Number(e.target.value))} /></label><label>Any problem? (optional)<textarea maxLength={200} value={problem} onChange={e => setProblem(e.target.value)} /></label><button disabled={busy}>Confirm receipt</button></form>}
            {trip.receipt ? <p className={s.note}>NGO confirmed {trip.receipt.servings} servings received at {tripTime(trip.receipt.at)}.{trip.receipt.problem ? ` Report: ${trip.receipt.problem}` : ""}</p> : <p className={s.note}>Both handovers verified. Waiting for the NGO’s receiving confirmation.</p>}
            {session.role === "donor" && <Link className={s.back} href={`/listings/${trip.listingId}`}>View donation receipt →</Link>}
          </>}
          <div className={s.next}><b>Next</b><p>{next}</p></div>
        </>}
        <section className={s.timeline} aria-label="Delivery progress">
          <h2>Delivery progress</h2>
          <ol>{trip.events.map(e => <li key={e.eventId}><time dateTime={new Date(e.at).toISOString()}>{tripTime(e.at)}</time><p>{e.reason}</p></li>)}</ol>
        </section>
        <Link href="/deliveries" className={s.back}>All deliveries</Link>
      </aside>
    </div>
  </main>;
}
