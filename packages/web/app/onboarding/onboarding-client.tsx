'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Stepper, type StepperStep } from '@/components/ui/stepper';
import { Button } from '@/components/ui/button';
import { ConnectStep } from './steps/connect-step';
import { PreflightStep } from './steps/preflight-step';
import { ScopeStep } from './steps/scope-step';
import { ScanStep } from './steps/scan-step';
import type { AzureConnectionStatus } from '@/lib/azure-credential';
import type { Category } from '@/lib/types';
import type { OnboardingRuleSummary } from '@/lib/rules';
import type { OnboardingState } from '@/lib/onboarding';

const STEPS: StepperStep[] = [
  { id: 1, label: 'Connect Azure' },
  { id: 2, label: 'Verify access' },
  { id: 3, label: 'Choose what to scan' },
  { id: 4, label: 'Run your first scan' },
];

export interface OnboardingClientProps {
  azureStatus: AzureConnectionStatus;
  categories: Category[];
  ruleSummaries: OnboardingRuleSummary[];
  onboarding: OnboardingState;
}

export function OnboardingClient({
  azureStatus: initialAzureStatus, categories, ruleSummaries: initialRuleSummaries, onboarding,
}: OnboardingClientProps) {
  const router = useRouter();
  const [step, setStep] = useState(() => {
    if (onboarding.status !== 'pending') return 1;
    return Math.min(Math.max(onboarding.lastStep, 1), 4);
  });
  const [azureStatus, setAzureStatus] = useState(initialAzureStatus);
  const [ruleSummaries, setRuleSummaries] = useState(initialRuleSummaries);
  const [busy, setBusy] = useState(false);

  function goToStep(next: number) {
    setStep(next);
    void fetch('/api/onboarding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'step', lastStep: next }),
    });
  }

  async function handleSkip() {
    setBusy(true);
    try {
      await fetch('/api/onboarding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'skip' }),
      });
      router.replace('/dashboard');
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleFinish() {
    setBusy(true);
    try {
      await fetch('/api/onboarding', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'complete' }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl space-y-8 px-6 py-10">
        <div className="flex items-center gap-3">
          <img src="/brand/mark.png" alt="RuleBeat" className="size-9 shrink-0 dark:hidden" />
          <img src="/brand/mark-dark.png" alt="RuleBeat" className="hidden size-9 shrink-0 dark:block" />
          <div>
            <h1 className="font-heading text-lg font-bold tracking-tight text-ink">Welcome to RuleBeat</h1>
            <p className="text-xs text-ink-2">Let&apos;s connect Azure and run your first scan.</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <Stepper steps={STEPS} current={step} />
          <Button variant="ghost" size="sm" onClick={() => void handleSkip()} disabled={busy}>
            Skip for now
          </Button>
        </div>

        {step === 1 && (
          <ConnectStep
            status={azureStatus}
            onVerified={setAzureStatus}
            onNext={() => goToStep(2)}
          />
        )}
        {step === 2 && (
          <PreflightStep
            onBack={() => goToStep(1)}
            onNext={() => goToStep(3)}
          />
        )}
        {step === 3 && (
          <ScopeStep
            categories={categories}
            ruleSummaries={ruleSummaries}
            onRuleSummariesChange={setRuleSummaries}
            onBack={() => goToStep(2)}
            onNext={() => goToStep(4)}
          />
        )}
        {step === 4 && (
          <ScanStep
            onBack={() => goToStep(3)}
            onFinish={handleFinish}
            busy={busy}
          />
        )}
      </div>
    </div>
  );
}
