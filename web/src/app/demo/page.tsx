import { Suspense } from "react";
import AppWalkthrough from "@/components/listing/AppWalkthrough";
export default function Page() { return <Suspense fallback={<main>Preparing the app…</main>}><AppWalkthrough /></Suspense>; }
