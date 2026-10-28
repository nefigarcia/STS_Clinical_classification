"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Check, Flag, Loader2, Pencil, Plus, X } from "lucide-react";
import { api } from "@/lib/client/fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { StatusBadge, formatDate } from "@/components/common";
import { cn } from "@/lib/utils";

const DECISIONS = [
  { value: "APPROVE", label: "Approve", icon: Check, cls: "data-[on=true]:bg-emerald-600 data-[on=true]:text-white" },
  { value: "REJECT", label: "Reject", icon: X, cls: "data-[on=true]:bg-rose-600 data-[on=true]:text-white" },
  { value: "CORRECT", label: "Correct", icon: Pencil, cls: "data-[on=true]:bg-sky-600 data-[on=true]:text-white" },
  { value: "NEEDS_REVIEW", label: "Needs further review", icon: Flag, cls: "data-[on=true]:bg-amber-500 data-[on=true]:text-white" },
] as const;

const decisionForm = z
  .object({
    decision: z.enum(["APPROVE", "REJECT", "CORRECT", "NEEDS_REVIEW"]),
    correctedComplication: z.string().trim().max(300).optional(),
    correctedStsCode: z.string().trim().max(20).optional(),
    comments: z.string().trim().max(4000).optional(),
  })
  .refine((d) => d.decision !== "CORRECT" || (d.correctedComplication?.length ?? 0) >= 2, {
    message: "Enter the corrected complication",
    path: ["correctedComplication"],
  });

type Review = {
  id: string;
  decision: string;
  previousStatus: string;
  correctedComplication: string | null;
  correctedStsCode: string | null;
  comments: string | null;
  reviewedAt: string;
  reviewer: { email: string; name: string | null };
};

export type PanelPrediction = {
  id: string;
  predictedComplication: string;
  stsCode: string | null;
  reviewStatus: string;
  reviews: Review[];
};

export function DecisionPanel({ prediction, canReview, onSaved }: { prediction: PanelPrediction | null; canReview: boolean; onSaved: () => void }) {
  const form = useForm<z.infer<typeof decisionForm>>({ resolver: zodResolver(decisionForm), defaultValues: { decision: "APPROVE" } });
  const decision = form.watch("decision");
  const [saving, setSaving] = useState(false);

  if (!prediction) return <p className="text-sm text-muted-foreground">Select a suggested complication to record a decision.</p>;

  const submit = form.handleSubmit(async (v) => {
    setSaving(true);
    try {
      await api("/api/reviews", {
        method: "POST",
        json: {
          type: "decision",
          predictionId: prediction.id,
          data: {
            decision: v.decision,
            correctedComplication: v.decision === "CORRECT" ? v.correctedComplication : null,
            correctedStsCode: v.decision === "CORRECT" ? v.correctedStsCode || null : null,
            comments: v.comments || null,
            expectedStatus: prediction.reviewStatus,
          },
        },
      });
      toast.success(`Decision saved: ${v.decision.replace("_", " ").toLowerCase()} — ${prediction.predictedComplication}`);
      form.reset({ decision: "APPROVE", comments: "", correctedComplication: "", correctedStsCode: "" });
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  });

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-muted-foreground">Deciding on</p>
        <p className="font-medium">{prediction.predictedComplication}</p>
        <div className="mt-1 flex items-center gap-2 text-xs">
          Current: <StatusBadge status={prediction.reviewStatus} />
        </div>
      </div>
      {canReview ? (
        <form onSubmit={submit} className="space-y-3">
          <fieldset>
            <legend className="sr-only">Decision</legend>
            <div className="grid grid-cols-2 gap-2">
              {DECISIONS.map((d) => (
                <button
                  type="button"
                  key={d.value}
                  data-on={decision === d.value}
                  aria-pressed={decision === d.value}
                  onClick={() => form.setValue("decision", d.value)}
                  className={cn(
                    "flex items-center justify-center gap-1.5 rounded-lg border px-2 py-2 text-sm font-medium transition-colors hover:bg-slate-50",
                    d.cls,
                  )}
                >
                  <d.icon className="size-4" aria-hidden /> {d.label}
                </button>
              ))}
            </div>
          </fieldset>
          {decision === "CORRECT" && (
            <div className="space-y-2 rounded-lg border bg-sky-50/50 p-3">
              <div className="space-y-1">
                <Label htmlFor="cc">Corrected complication</Label>
                <Input id="cc" {...form.register("correctedComplication")} aria-invalid={Boolean(form.formState.errors.correctedComplication)} />
                {form.formState.errors.correctedComplication && (
                  <p className="text-xs text-destructive">{form.formState.errors.correctedComplication.message}</p>
                )}
              </div>
              <div className="space-y-1">
                <Label htmlFor="cs">STS code (must exist in the loaded manual)</Label>
                <Input id="cs" {...form.register("correctedStsCode")} placeholder="optional" />
              </div>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="cm">Comments</Label>
            <Textarea id="cm" rows={3} {...form.register("comments")} placeholder="Rationale, STS rule interpretation…" />
          </div>
          <Button type="submit" className="w-full" disabled={saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden />} Save decision
          </Button>
          <p className="text-[11px] text-muted-foreground">Decisions are append-only; earlier decisions remain in the audit history.</p>
        </form>
      ) : (
        <p className="rounded-md bg-slate-100 p-3 text-sm">Read-only access: decisions require the Clinical Reviewer role.</p>
      )}
      {prediction.reviews.length > 0 && (
        <div>
          <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">History</h4>
          <ol className="space-y-2 text-xs">
            {prediction.reviews.map((r) => (
              <li key={r.id} className="rounded-md border bg-white p-2">
                <div className="flex justify-between gap-2">
                  <span className="font-medium">{r.decision.replace("_", " ")}</span>
                  <span className="text-muted-foreground">{formatDate(r.reviewedAt, true)}</span>
                </div>
                <div className="text-muted-foreground">
                  {r.reviewer.name ?? r.reviewer.email} · was {r.previousStatus.toLowerCase()}
                </div>
                {r.correctedComplication && (
                  <div>
                    → {r.correctedComplication}
                    {r.correctedStsCode && ` (${r.correctedStsCode})`}
                  </div>
                )}
                {r.comments && <div className="mt-1 italic">“{r.comments}”</div>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

const missingForm = z.object({
  complication: z.string().trim().min(2, "Required").max(300),
  stsCode: z.string().trim().max(20).optional(),
  eventDate: z.string().optional(),
  excerpt: z.string().trim().max(2000).optional(),
  comments: z.string().trim().max(4000).optional(),
});

export function AddMissingForm({
  encounterId,
  currentNoteId,
  currentNoteLabel,
  onSaved,
}: {
  encounterId: string;
  currentNoteId: string | null;
  currentNoteLabel: string | null;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const form = useForm<z.infer<typeof missingForm>>({ resolver: zodResolver(missingForm) });
  const submit = form.handleSubmit(async (v) => {
    try {
      await api("/api/reviews", {
        method: "POST",
        json: {
          type: "add_missing",
          encounterId,
          data: {
            complication: v.complication,
            stsCode: v.stsCode || null,
            eventDate: v.eventDate || null,
            comments: v.comments || null,
            evidence: v.excerpt && currentNoteId ? [{ clinicalNoteId: currentNoteId, excerpt: v.excerpt }] : [],
          },
        },
      });
      toast.success("Missing complication added");
      form.reset();
      setOpen(false);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    }
  });
  if (!open)
    return (
      <Button variant="outline" className="w-full" onClick={() => setOpen(true)}>
        <Plus aria-hidden /> Add missing complication
      </Button>
    );
  return (
    <form onSubmit={submit} className="space-y-2 rounded-lg border p-3">
      <h4 className="text-sm font-semibold">Add missing complication</h4>
      <Input placeholder="Complication" aria-label="Complication" {...form.register("complication")} />
      {form.formState.errors.complication && <p className="text-xs text-destructive">{form.formState.errors.complication.message}</p>}
      <div className="grid grid-cols-2 gap-2">
        <Input placeholder="STS code (optional)" aria-label="STS code" {...form.register("stsCode")} />
        <Input type="date" aria-label="Event date" {...form.register("eventDate")} />
      </div>
      <Textarea
        rows={2}
        placeholder={currentNoteLabel ? `Exact excerpt from ${currentNoteLabel}` : "Open a note to cite evidence"}
        aria-label="Evidence excerpt"
        disabled={!currentNoteId}
        {...form.register("excerpt")}
      />
      <Textarea rows={2} placeholder="Comments" aria-label="Comments" {...form.register("comments")} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={form.formState.isSubmitting}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
