"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import { useFactoryOsSession } from "@/components/auth/factoryos-session-provider";

type StepId =
  | "factory_profile"
  | "sites"
  | "lines"
  | "shifts"
  | "holiday_calendar"
  | "energy_sources"
  | "role_set";

type FieldDefinition = {
  name: string;
  label: string;
  labelBn: string;
  placeholder: string;
  placeholderBn: string;
  multiline?: boolean;
};

type StepDefinition = {
  id: StepId;
  title: string;
  titleBn: string;
  description: string;
  descriptionBn: string;
  fields: FieldDefinition[];
};

type StepValues = Record<string, string>;
type DraftValues = Record<StepId, StepValues>;

const steps: StepDefinition[] = [
  {
    id: "factory_profile",
    title: "Factory profile",
    titleBn: "কারখানার পরিচিতি",
    description: "Set the primary identity and operating defaults for this factory.",
    descriptionBn: "এই কারখানার পরিচিতি ও পরিচালনার প্রাথমিক সেটিংস দিন।",
    fields: [
      { name: "name", label: "Factory name", labelBn: "কারখানার নাম", placeholder: "e.g. Dhaka Garments Ltd.", placeholderBn: "যেমন: ঢাকা গার্মেন্টস লিমিটেড" },
      { name: "code", label: "Factory code", labelBn: "কারখানার কোড", placeholder: "e.g. DHA-01", placeholderBn: "যেমন: DHA-01" },
      { name: "timezone", label: "Time zone", labelBn: "টাইম জোন", placeholder: "Asia/Dhaka", placeholderBn: "Asia/Dhaka" },
      { name: "defaultLocale", label: "Default language", labelBn: "ডিফল্ট ভাষা", placeholder: "en-BD or bn-BD", placeholderBn: "en-BD অথবা bn-BD" },
    ],
  },
  {
    id: "sites",
    title: "Sites and buildings",
    titleBn: "সাইট ও ভবন",
    description: "Add each physical site or building on a separate line.",
    descriptionBn: "প্রতিটি সাইট বা ভবনের তথ্য আলাদা লাইনে লিখুন।",
    fields: [
      { name: "items", label: "Site entries", labelBn: "সাইটের তালিকা", placeholder: "SITE-01 | Main factory | Dhaka\nSITE-02 | Warehouse | Gazipur", placeholderBn: "SITE-01 | Main factory | Dhaka\nSITE-02 | Warehouse | Gazipur", multiline: true },
    ],
  },
  {
    id: "lines",
    title: "Production lines",
    titleBn: "প্রোডাকশন লাইন",
    description: "List production lines and the site where each line operates.",
    descriptionBn: "প্রতিটি প্রোডাকশন লাইন এবং সেটি কোন সাইটে আছে তা লিখুন।",
    fields: [
      { name: "items", label: "Production line entries", labelBn: "প্রোডাকশন লাইনের তালিকা", placeholder: "LINE-01 | Sewing line 1 | SITE-01\nLINE-02 | Sewing line 2 | SITE-01", placeholderBn: "LINE-01 | Sewing line 1 | SITE-01\nLINE-02 | Sewing line 2 | SITE-01", multiline: true },
    ],
  },
  {
    id: "shifts",
    title: "Shifts and working hours",
    titleBn: "শিফট ও কর্মঘণ্টা",
    description: "Capture shift windows and break duration. Use 24-hour time.",
    descriptionBn: "শিফটের সময় ও বিরতির সময় লিখুন। ২৪ ঘণ্টার সময় ব্যবহার করুন।",
    fields: [
      { name: "items", label: "Shift entries", labelBn: "শিফটের তালিকা", placeholder: "DAY | 08:00 | 17:00 | 60\nNIGHT | 20:00 | 05:00 | 60", placeholderBn: "DAY | 08:00 | 17:00 | 60\nNIGHT | 20:00 | 05:00 | 60", multiline: true },
    ],
  },
  {
    id: "holiday_calendar",
    title: "Holiday calendar",
    titleBn: "ছুটির ক্যালেন্ডার",
    description: "Enter planned holidays using YYYY-MM-DD, one date per line.",
    descriptionBn: "প্রতিটি ছুটির তারিখ YYYY-MM-DD ফরম্যাটে আলাদা লাইনে লিখুন।",
    fields: [
      { name: "dates", label: "Holiday dates", labelBn: "ছুটির তারিখ", placeholder: "2026-12-16\n2026-12-25", placeholderBn: "2026-12-16\n2026-12-25", multiline: true },
      { name: "notes", label: "Calendar notes", labelBn: "ক্যালেন্ডার নোট", placeholder: "Optional notes about shutdowns or special working days.", placeholderBn: "বিশেষ বন্ধ বা কর্মদিবস সম্পর্কে অতিরিক্ত তথ্য।", multiline: true },
    ],
  },
  {
    id: "energy_sources",
    title: "Energy sources",
    titleBn: "জ্বালানি ও বিদ্যুৎ উৎস",
    description: "Record the energy sources used at this factory. Do not enter credentials or secrets.",
    descriptionBn: "কারখানায় ব্যবহৃত জ্বালানি ও বিদ্যুৎ উৎস লিখুন। কোনো পাসওয়ার্ড বা গোপন তথ্য দেবেন না।",
    fields: [
      { name: "items", label: "Energy source entries", labelBn: "এনার্জি সোর্সের তালিকা", placeholder: "ELECTRICITY | Grid | Main meter\nGAS | Natural gas | Boiler", placeholderBn: "ELECTRICITY | Grid | Main meter\nGAS | Natural gas | Boiler", multiline: true },
    ],
  },
  {
    id: "role_set",
    title: "Role set",
    titleBn: "ব্যবহারকারীর ভূমিকা",
    description: "Identify the role templates required by this factory. This draft does not grant permissions.",
    descriptionBn: "কারখানায় প্রয়োজনীয় ভূমিকা নির্বাচন বা লিখুন। এই ড্রাফট কোনো permission প্রদান করে না।",
    fields: [
      { name: "roles", label: "Required roles", labelBn: "প্রয়োজনীয় ভূমিকা", placeholder: "OWNER | Owner / MD\nPLANNER | Planner\nPRODUCTION_MANAGER | Production Manager\nQA_MANAGER | QA Manager\nSTORE_KEEPER | Store Keeper\nHR_ADMIN | HR / Admin", placeholderBn: "OWNER | Owner / MD\nPLANNER | Planner\nPRODUCTION_MANAGER | Production Manager\nQA_MANAGER | QA Manager\nSTORE_KEEPER | Store Keeper\nHR_ADMIN | HR / Admin", multiline: true },
    ],
  },
];

const emptyDrafts = (): DraftValues => Object.fromEntries(
  steps.map((step) => [
    step.id,
    Object.fromEntries(step.fields.map((field) => [field.name, ""])),
  ]),
) as DraftValues;

function isStepId(value: string): value is StepId {
  return steps.some((step) => step.id === value);
}

export default function OnboardingPage() {
  const {
    status,
    snapshot,
    activeFactoryId,
    hasPermission,
    request,
  } = useFactoryOsSession();
  const [locale, setLocale] = useState<"en" | "bn">("en");
  const [activeStep, setActiveStep] = useState<StepId>("factory_profile");
  const [drafts, setDrafts] = useState<DraftValues>(emptyDrafts);
  const [savedSteps, setSavedSteps] = useState<Set<StepId>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const activeFactoryIdRef = useRef(activeFactoryId);

  useEffect(() => {
    activeFactoryIdRef.current = activeFactoryId;
  }, [activeFactoryId]);

  const currentStep = useMemo(
    () => steps.find((step) => step.id === activeStep) ?? steps[0],
    [activeStep],
  );
  const connected = status === "connected" && snapshot !== null;
  const allowed = hasPermission("factory.onboarding.manage");
  const activeFactory = snapshot?.factories.find((factory) => factory.id === activeFactoryId);
  const progress = Math.round((savedSteps.size / steps.length) * 100);

  useEffect(() => {
    let active = true;
    if (!connected || !activeFactoryId || !allowed) return;
    setLoading(true);
    setError("");
    void request("/onboarding/steps")
      .then((result) => {
        if (!active) return;
        const response = result as {
          items?: Array<{ step_key: string; payload: Record<string, unknown> }>;
        };
        const next = emptyDrafts();
        const completed = new Set<StepId>();
        for (const item of response.items ?? []) {
          if (!isStepId(item.step_key)) continue;
          for (const field of steps.find((step) => step.id === item.step_key)?.fields ?? []) {
            const value = item.payload?.[field.name];
            if (typeof value === "string") next[item.step_key][field.name] = value;
          }
          completed.add(item.step_key);
        }
        setDrafts(next);
        setSavedSteps(completed);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load onboarding drafts.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [connected, activeFactoryId, allowed, request]);

  const updateField = (fieldName: string, value: string) => {
    setDrafts((current) => ({
      ...current,
      [activeStep]: {
        ...current[activeStep],
        [fieldName]: value,
      },
    }));
    setNotice("");
  };

  const saveCurrentStep = async () => {
    if (!activeFactoryId || !allowed) return;
    setSaving(true);
    setError("");
    setNotice("");
    const factoryIdAtSave = activeFactoryId;
    const stepAtSave = activeStep;
    try {
      await request("/onboarding/steps/" + stepAtSave, {
        method: "PUT",
        body: { payload: drafts[stepAtSave] },
      });
      if (activeFactoryIdRef.current !== factoryIdAtSave) return;
      setSavedSteps((current) => new Set(current).add(stepAtSave));
      setNotice(locale === "bn" ? "এই ধাপের ড্রাফট সংরক্ষিত হয়েছে।" : "This step draft has been saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this step.");
    } finally {
      setSaving(false);
    }
  };

  if (!connected) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">FactoryOS setup</p>
          <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-950">
            {locale === "bn" ? "কারখানা সেটআপ শুরু করুন" : "Start factory onboarding"}
          </h1>
          <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">
            {locale === "bn"
              ? "প্রথমে একটি authenticated workspace session connect করুন।"
              : "Connect an authenticated workspace session before opening the factory setup wizard."}
          </p>
          <Link href="/session" className="mt-6 inline-flex min-h-10 items-center rounded-lg bg-blue-700 px-4 text-sm font-semibold text-white hover:bg-blue-800">
            Connect workspace session
          </Link>
        </section>
      </main>
    );
  }

  if (!activeFactory) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <section className="rounded-2xl border border-amber-200 bg-amber-50 p-8">
          <h1 className="text-xl font-bold text-slate-950">{locale === "bn" ? "কারখানা নির্বাচন প্রয়োজন" : "Select a factory"}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-700">
            {locale === "bn"
              ? "উপরের factory selector থেকে একটি active factory নির্বাচন করুন।"
              : "Choose an active factory from the workspace selector before saving onboarding drafts."}
          </p>
        </section>
      </main>
    );
  }

  if (!allowed) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <section className="rounded-2xl border border-rose-200 bg-rose-50 p-8">
          <h1 className="text-xl font-bold text-slate-950">{locale === "bn" ? "অনুমতি নেই" : "Permission required"}</h1>
          <p className="mt-2 text-sm leading-6 text-slate-700">
            {locale === "bn"
              ? "এই workspace-এ factory.onboarding.manage permission নেই। API-র permission check-ই চূড়ান্ত।"
              : "This workspace does not include factory.onboarding.manage. The API remains the final authorization authority."}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-blue-700">FactoryOS · Setup</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
            {locale === "bn" ? "কারখানা অনবোর্ডিং" : "Factory onboarding"}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            {locale === "bn"
              ? "ধাপে ধাপে কারখানার প্রাথমিক তথ্য প্রস্তুত করুন। প্রতিটি ধাপ আলাদাভাবে সংরক্ষণ করা যাবে।"
              : "Build the factory foundation one step at a time. Each step is saved independently and can be resumed later."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{locale === "bn" ? "সক্রিয় কারখানা" : "Active factory"}</p>
            <p className="mt-0.5 text-sm font-bold text-slate-900">{activeFactory.code} · {activeFactory.name}</p>
          </div>
          <div className="flex rounded-xl border border-slate-200 bg-white p-1">
            <button type="button" onClick={() => setLocale("en")} aria-pressed={locale === "en"} className={["rounded-lg px-3 py-2 text-xs font-semibold", locale === "en" ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100"].join(" ")}>English</button>
            <button type="button" onClick={() => setLocale("bn")} aria-pressed={locale === "bn"} className={["rounded-lg px-3 py-2 text-xs font-semibold", locale === "bn" ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100"].join(" ")}>বাংলা</button>
          </div>
        </div>
      </div>

      <section className="mt-7 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6" aria-label="Onboarding progress">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-slate-950">{locale === "bn" ? "সেটআপ অগ্রগতি" : "Setup progress"}</p>
            <p className="mt-1 text-xs text-slate-500">{savedSteps.size} / {steps.length} {locale === "bn" ? "ধাপ সংরক্ষিত" : "steps saved"}</p>
          </div>
          <p className="text-2xl font-bold tabular-nums text-slate-950">{progress}%</p>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-100">
          <div className="h-full rounded-full bg-blue-700 transition-[width]" style={{ width: progress + "%" }} />
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[290px_minmax(0,1fr)]">
        <nav aria-label="Onboarding steps" className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
          <ol className="space-y-1">
            {steps.map((step, index) => {
              const active = step.id === activeStep;
              const saved = savedSteps.has(step.id);
              return (
                <li key={step.id}>
                  <button
                    type="button"
                    onClick={() => { setActiveStep(step.id); setError(""); setNotice(""); }}
                    aria-current={active ? "step" : undefined}
                    className={[
                      "flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors",
                      "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700",
                      active ? "bg-slate-950 text-white" : "text-slate-700 hover:bg-slate-50",
                    ].join(" ")}
                  >
                    <span className={[
                      "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                      active ? "bg-white/15 text-white" : saved ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600",
                    ].join(" ")}>
                      {saved ? "✓" : index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{locale === "bn" ? step.titleBn : step.title}</span>
                      <span className={["mt-0.5 block text-[11px]", active ? "text-slate-300" : "text-slate-500"].join(" ")}>
                        {saved ? (locale === "bn" ? "সংরক্ষিত" : "Saved") : (locale === "bn" ? "অসম্পূর্ণ" : "Not saved")}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.16em] text-blue-700">
                {locale === "bn" ? `ধাপ ${steps.findIndex((step) => step.id === activeStep) + 1} / ${steps.length}` : `Step ${steps.findIndex((step) => step.id === activeStep) + 1} of ${steps.length}`}
              </p>
              <h2 className="mt-2 text-xl font-bold tracking-tight text-slate-950">{locale === "bn" ? currentStep.titleBn : currentStep.title}</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">{locale === "bn" ? currentStep.descriptionBn : currentStep.description}</p>
            </div>
            {savedSteps.has(activeStep) ? (
              <span className="inline-flex items-center rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800">
                {locale === "bn" ? "সেভ করা হয়েছে" : "Saved"}
              </span>
            ) : null}
          </div>

          {loading ? <p className="mt-6 text-sm text-slate-500">{locale === "bn" ? "ড্রাফট লোড হচ্ছে…" : "Loading saved drafts…"}</p> : null}

          <div className="mt-7 grid gap-5 sm:grid-cols-2">
            {currentStep.fields.map((field) => (
              <label key={field.name} className={field.multiline ? "sm:col-span-2" : ""}>
                <span className="mb-2 block text-sm font-semibold text-slate-800">{locale === "bn" ? field.labelBn : field.label}</span>
                {field.multiline ? (
                  <textarea
                    rows={7}
                    value={drafts[activeStep][field.name] ?? ""}
                    onChange={(event) => updateField(field.name, event.target.value)}
                    placeholder={locale === "bn" ? field.placeholderBn : field.placeholder}
                    className="min-h-36 w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
                  />
                ) : (
                  <input
                    value={drafts[activeStep][field.name] ?? ""}
                    onChange={(event) => updateField(field.name, event.target.value)}
                    placeholder={locale === "bn" ? field.placeholderBn : field.placeholder}
                    className="min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
                  />
                )}
              </label>
            ))}
          </div>

          <div className="mt-6 rounded-xl border border-blue-100 bg-blue-50/70 p-4">
            <p className="text-xs leading-5 text-blue-950">
              {locale === "bn"
                ? "এটি একটি সংরক্ষিত ড্রাফট। এখানে দেওয়া তথ্য এখনো factory master data তৈরি বা পরিবর্তন করে না এবং কোনো role permission grant করে না।"
                : "This is a saved onboarding draft only. It does not create or change factory master data and does not grant any role permissions."}
            </p>
          </div>

          {error ? <p role="alert" className="mt-5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
          {notice ? <p role="status" className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p> : null}

          <div className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5">
            <button
              type="button"
              disabled={steps.findIndex((step) => step.id === activeStep) === 0}
              onClick={() => setActiveStep(steps[Math.max(0, steps.findIndex((step) => step.id === activeStep) - 1)].id)}
              className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {locale === "bn" ? "পেছনে" : "Back"}
            </button>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => void saveCurrentStep()}
                disabled={saving || loading}
                className="min-h-10 rounded-lg bg-blue-700 px-5 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-wait disabled:opacity-60"
              >
                {saving ? (locale === "bn" ? "সংরক্ষণ হচ্ছে…" : "Saving…") : (locale === "bn" ? "ধাপ সংরক্ষণ করুন" : "Save step")}
              </button>
              <button
                type="button"
                disabled={steps.findIndex((step) => step.id === activeStep) === steps.length - 1}
                onClick={() => setActiveStep(steps[Math.min(steps.length - 1, steps.findIndex((step) => step.id === activeStep) + 1)].id)}
                className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {locale === "bn" ? "পরবর্তী ধাপ" : "Next step"}
              </button>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
