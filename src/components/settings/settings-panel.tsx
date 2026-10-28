"use client";

import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { CheckCircle2, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { api } from "@/lib/client/fetch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelectClass, formatDate } from "@/components/common";

type Settings = {
  processingLimits: {
    maxJobTokenBudget: number;
    maxEncounterCostUsd: number;
    maxEscalationRate: number;
    concurrency: number;
    retryLimit: number;
    dailyCostLimitUsd: number;
  };
  modelPricing: Record<string, { inputPer1M: number; cachedInputPer1M: number; outputPer1M: number }>;
  retrieval: { topRules: number; topExamples: number; maxPassages: number; passageChars: number; passageOverlap: number };
  labelMap: Record<string, string>;
  highRiskTerms: string[];
  embedNotesAuthorized: boolean;
  modelVerification: Record<string, { ok: boolean; checkedAt: string; error: string | null }>;
};
type Payload = {
  settings: Settings;
  status: { openaiConfigured: boolean; phiExternalAiApproved: boolean; approvedManual: boolean; appEnv: string };
  models: { primary: string; escalation: string; embedding: string; primaryEffort: string; escalationEffort: string };
};

const limitsSchema = z.object({
  maxJobTokenBudget: z.coerce.number().int().positive(),
  maxEncounterCostUsd: z.coerce.number().positive(),
  maxEscalationRate: z.coerce.number().min(0).max(1),
  concurrency: z.coerce.number().int().min(1).max(16),
  retryLimit: z.coerce.number().int().min(0).max(10),
  dailyCostLimitUsd: z.coerce.number().positive(),
});

function Gate({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" aria-hidden /> : <XCircle className="mt-0.5 size-4 text-rose-600" aria-hidden />}
      <span>
        <span className="font-medium">{label}</span> <span className="text-muted-foreground">— {detail}</span>
      </span>
    </li>
  );
}

export function SettingsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<Payload | null>(null);
  const load = useCallback(
    () =>
      api<Payload>("/api/admin/settings")
        .then(setData)
        .catch((e) => toast.error(e.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  async function save(key: string, value: unknown) {
    try {
      await api("/api/admin/settings", { method: "PUT", json: { key, value } });
      toast.success("Saved");
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (!data)
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
      </p>
    );
  const { settings: s, status, models } = data;
  const modelIds = [...new Set([models.primary, models.escalation, models.embedding])];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5" aria-hidden /> Safety gates
            </CardTitle>
            <CardDescription>
              AI processing runs only when every required gate passes. Gates come from environment variables and administrator actions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              <Gate
                ok={status.openaiConfigured}
                label="OpenAI API key"
                detail={status.openaiConfigured ? "configured (server-side only)" : "OPENAI_API_KEY not set"}
              />
              <Gate
                ok={status.approvedManual}
                label="Approved STS manual"
                detail={status.approvedManual ? "available" : "upload, index and approve the official manual"}
              />
              <Gate
                ok={status.phiExternalAiApproved}
                label="PHI external-AI approval"
                detail={status.phiExternalAiApproved ? "PHI_EXTERNAL_AI_APPROVED=true" : "off: only SYNTHETIC datasets may be sent"}
              />
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              Environment: {status.appEnv}. Before enabling PHI: confirm the OpenAI BAA and retention controls, the hosting (Vercel) and database BAAs, and
              Children&apos;s Nebraska security and compliance approval.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Models</CardTitle>
            <CardDescription>
              Configured by environment variables. The requested IDs are not assumed to exist; verify them against your OpenAI account. Unavailable models are
              never silently replaced.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <table className="w-full">
              <tbody>
                {[
                  ["Primary", models.primary, models.primaryEffort],
                  ["Escalation", models.escalation, models.escalationEffort],
                  ["Embedding", models.embedding, "—"],
                ].map(([role, id, effort]) => {
                  const v = s.modelVerification[id];
                  return (
                    <tr key={role} className="border-t">
                      <td className="py-1.5 text-muted-foreground">{role}</td>
                      <td className="font-mono">{id}</td>
                      <td className="text-xs">effort: {effort}</td>
                      <td className="text-xs">
                        {v ? (
                          v.ok ? (
                            <span className="text-emerald-700">verified {formatDate(v.checkedAt)}</span>
                          ) : (
                            <span className="text-rose-700">not available ({v.error})</span>
                          )
                        ) : (
                          <span className="text-muted-foreground">not verified</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {isAdmin && (
              <Button
                size="sm"
                variant="outline"
                disabled={!status.openaiConfigured}
                onClick={() =>
                  api("/api/admin/verify-models", { method: "POST" })
                    .then(() => (toast.success("Verification complete"), load()))
                    .catch((e) => toast.error(e.message))
                }
              >
                Verify models
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      <LimitsCard value={s.processingLimits} disabled={!isAdmin} onSave={(v) => save("processingLimits", v)} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Model pricing (USD per 1M tokens)</CardTitle>
            <CardDescription>
              Take these from the current OpenAI price sheet. Without a price, cost shows as unknown and only token budgets apply.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PricingForm ids={modelIds} value={s.modelPricing} disabled={!isAdmin} onSave={(v) => save("modelPricing", v)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Retrieval</CardTitle>
            <CardDescription>Changing these invalidates cached classifications through the cache key.</CardDescription>
          </CardHeader>
          <CardContent>
            <NumberGrid value={s.retrieval} disabled={!isAdmin} onSave={(v) => save("retrieval", v)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Label mapping for evaluation</CardTitle>
            <CardDescription>
              One mapping per line: <code>historical label = canonical STS complication name</code>. Original labels are never modified.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LabelMapForm value={s.labelMap} disabled={!isAdmin} onSave={(v) => save("labelMap", v)} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Escalation triggers</CardTitle>
            <CardDescription>
              Predictions whose label contains any of these terms are treated as high-risk and may be sent to the escalation model, within the escalation-rate
              cap.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TermsForm value={s.highRiskTerms} disabled={!isAdmin} onSave={(v) => save("highRiskTerms", v)} />
          </CardContent>
        </Card>
      </div>

      {isAdmin && <UsersCard />}
      <VersionsCard isAdmin={isAdmin} />
      {isAdmin && <AuditCard />}
    </div>
  );
}

function LimitsCard({
  value,
  disabled,
  onSave,
}: {
  value: Settings["processingLimits"];
  disabled: boolean;
  onSave: (v: Settings["processingLimits"]) => void;
}) {
  const form = useForm({ resolver: zodResolver(limitsSchema), defaultValues: value });
  const fields: [keyof Settings["processingLimits"], string, string][] = [
    ["maxJobTokenBudget", "Max job token budget", "tokens"],
    ["maxEncounterCostUsd", "Max per-encounter cost", "USD"],
    ["maxEscalationRate", "Max escalation rate", "0-1"],
    ["concurrency", "Concurrency", "workers"],
    ["retryLimit", "Request retry limit", "retries"],
    ["dailyCostLimitUsd", "Daily API cost limit", "USD"],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Processing limits</CardTitle>
        <CardDescription>A job pauses (and can be resumed) when it reaches a budget.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit((v) => onSave(v as Settings["processingLimits"]))} className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {fields.map(([k, label, unit]) => (
            <div key={k} className="space-y-1">
              <Label htmlFor={k}>{label}</Label>
              <Input id={k} type="number" step="any" disabled={disabled} {...form.register(k)} aria-describedby={`${k}-u`} />
              <span id={`${k}-u`} className="text-xs text-muted-foreground">
                {unit}
              </span>
              {form.formState.errors[k] && <p className="text-xs text-destructive">{String(form.formState.errors[k]?.message)}</p>}
            </div>
          ))}
          {!disabled && (
            <div className="sm:col-span-3 lg:col-span-6">
              <Button type="submit" size="sm">
                Save limits
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function PricingForm({
  ids,
  value,
  disabled,
  onSave,
}: {
  ids: string[];
  value: Settings["modelPricing"];
  disabled: boolean;
  onSave: (v: Settings["modelPricing"]) => void;
}) {
  const [rows, setRows] = useState(
    () =>
      Object.fromEntries(ids.map((id) => [id, value[id] ? { ...value[id] } : { inputPer1M: "", cachedInputPer1M: "", outputPer1M: "" }])) as Record<
        string,
        Record<string, number | string>
      >,
  );
  return (
    <div className="space-y-2">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th>Model</th>
            <th>Input</th>
            <th>Cached input</th>
            <th>Output</th>
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => (
            <tr key={id}>
              <td className="pr-2 font-mono text-xs">{id}</td>
              {(["inputPer1M", "cachedInputPer1M", "outputPer1M"] as const).map((k) => (
                <td key={k} className="p-1">
                  <Input
                    type="number"
                    step="any"
                    min={0}
                    disabled={disabled}
                    aria-label={`${id} ${k}`}
                    value={rows[id][k]}
                    onChange={(e) => setRows({ ...rows, [id]: { ...rows[id], [k]: e.target.value } })}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!disabled && (
        <Button
          size="sm"
          onClick={() => {
            const out: Settings["modelPricing"] = {};
            for (const [id, r] of Object.entries(rows)) {
              if (r.inputPer1M === "" || r.outputPer1M === "") continue;
              out[id] = { inputPer1M: Number(r.inputPer1M), cachedInputPer1M: Number(r.cachedInputPer1M || 0), outputPer1M: Number(r.outputPer1M) };
            }
            onSave(out);
          }}
        >
          Save pricing
        </Button>
      )}
    </div>
  );
}

function NumberGrid<T extends Record<string, number>>({ value, disabled, onSave }: { value: T; disabled: boolean; onSave: (v: T) => void }) {
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(Object.entries(value).map(([k, x]) => [k, String(x)])));
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {Object.keys(value).map((k) => (
          <div key={k} className="space-y-1">
            <Label htmlFor={`r-${k}`}>{k}</Label>
            <Input id={`r-${k}`} type="number" disabled={disabled} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />
          </div>
        ))}
      </div>
      {!disabled && (
        <Button size="sm" onClick={() => onSave(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Number(x)])) as T)}>
          Save
        </Button>
      )}
    </div>
  );
}

function LabelMapForm({ value, disabled, onSave }: { value: Record<string, string>; disabled: boolean; onSave: (v: Record<string, string>) => void }) {
  const [text, setText] = useState(
    Object.entries(value)
      .map(([k, v]) => `${k} = ${v}`)
      .join("\n"),
  );
  return (
    <div className="space-y-2">
      <Textarea
        rows={6}
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"interventional cath = <STS complication name from manual>"}
        className="font-mono text-xs"
        aria-label="Label map"
      />
      {!disabled && (
        <Button
          size="sm"
          onClick={() =>
            onSave(
              Object.fromEntries(
                text
                  .split("\n")
                  .map((l) => l.split("=").map((x) => x.trim()))
                  .filter((p) => p.length === 2 && p[0] && p[1])
                  .map(([a, b]) => [a.toLowerCase(), b]),
              ),
            )
          }
        >
          Save mapping
        </Button>
      )}
    </div>
  );
}

function TermsForm({ value, disabled, onSave }: { value: string[]; disabled: boolean; onSave: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  return (
    <div className="space-y-2">
      <Textarea rows={3} disabled={disabled} value={text} onChange={(e) => setText(e.target.value)} aria-label="High-risk terms" />
      {!disabled && (
        <Button
          size="sm"
          onClick={() =>
            onSave(
              text
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            )
          }
        >
          Save terms
        </Button>
      )}
    </div>
  );
}

type U = { id: string; email: string; name: string | null; role: string; active: boolean; lastLoginAt: string | null };
function UsersCard() {
  const [users, setUsers] = useState<U[]>([]);
  const load = useCallback(
    () =>
      api<{ users: U[] }>("/api/admin/users")
        .then((r) => setUsers(r.users))
        .catch((e) => toast.error(e.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  const patch = (id: string, body: object) =>
    api("/api/admin/users", { method: "PATCH", json: { id, ...body } })
      .then(() => (toast.success("User updated"), load()))
      .catch((e) => toast.error(e.message));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Users and roles</CardTitle>
        <CardDescription>Roles from Entra app-role claims override these on each sign-in. Every server endpoint checks the role.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">User</th>
              <th>Role</th>
              <th>Active</th>
              <th>Last sign-in</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t">
                <td className="px-3 py-1.5">
                  {u.name ?? u.email}
                  <div className="text-xs text-muted-foreground">{u.email}</div>
                </td>
                <td>
                  <select
                    aria-label={`Role for ${u.email}`}
                    className={NativeSelectClass}
                    value={u.role}
                    onChange={(e) => patch(u.id, { role: e.target.value })}
                  >
                    <option value="ADMIN">Administrator</option>
                    <option value="REVIEWER">Clinical Reviewer</option>
                    <option value="READ_ONLY">Read-Only User</option>
                  </select>
                </td>
                <td>
                  <input type="checkbox" aria-label={`Active ${u.email}`} checked={u.active} onChange={(e) => patch(u.id, { active: e.target.checked })} />
                </td>
                <td className="text-xs">{formatDate(u.lastLoginAt, true)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

type Versions = {
  prompts: { id: string; version: string; active: boolean; notes: string | null; createdAt: string; systemPrompt: string }[];
  libraries: { id: string; version: number; active: boolean; notes: string | null; createdAt: string; count: number }[];
  defaultPrompt: { version: string; systemPrompt: string };
};
function VersionsCard({ isAdmin }: { isAdmin: boolean }) {
  const [v, setV] = useState<Versions | null>(null);
  const [draft, setDraft] = useState({ version: "", systemPrompt: "", notes: "" });
  const load = useCallback(
    () =>
      api<Versions>("/api/admin/versions")
        .then(
          (r) => (
            setV(r),
            setDraft((d) => (d.systemPrompt ? d : { ...d, systemPrompt: r.prompts.find((p) => p.active)?.systemPrompt ?? r.defaultPrompt.systemPrompt }))
          ),
        )
        .catch((e) => toast.error(e.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  const post = (body: object, msg: string) =>
    api("/api/admin/versions", { method: "POST", json: body })
      .then(() => (toast.success(msg), load()))
      .catch((e) => toast.error(e.message));
  if (!v) return null;
  const activePrompt = v.prompts.find((p) => p.active);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Prompt versions</CardTitle>
          <CardDescription>
            Active: {activePrompt?.version ?? `${v.defaultPrompt.version} (built-in default)`}. Activating an earlier version rolls back.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ul className="space-y-1 text-sm">
            {v.prompts.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                <span>
                  <span className="font-mono">{p.version}</span> {p.active && <span className="text-xs text-emerald-700">active</span>}{" "}
                  <span className="text-xs text-muted-foreground">
                    {formatDate(p.createdAt)} {p.notes}
                  </span>
                </span>
                {isAdmin && !p.active && (
                  <Button size="xs" variant="outline" onClick={() => post({ action: "activate_prompt", version: p.version }, "Prompt activated")}>
                    Activate
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {isAdmin && (
            <div className="space-y-2 rounded-lg border p-3">
              <Input
                placeholder="New version (e.g. 1.1.0)"
                aria-label="Prompt version"
                value={draft.version}
                onChange={(e) => setDraft({ ...draft, version: e.target.value })}
              />
              <Textarea
                rows={8}
                className="font-mono text-xs"
                aria-label="System prompt"
                value={draft.systemPrompt}
                onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })}
              />
              <Input placeholder="Change notes" aria-label="Change notes" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
              <Button size="sm" onClick={() => post({ action: "create_prompt", ...draft, activate: true }, "Prompt version created and activated")}>
                Create and activate
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Verified example library versions</CardTitle>
          <CardDescription>
            A snapshot is created each time an example is verified or excluded. Activate an earlier snapshot to roll back retrieval examples.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {isAdmin && (
            <Button size="sm" variant="outline" onClick={() => post({ action: "snapshot_library", notes: "Manual snapshot" }, "Snapshot created")}>
              Create snapshot
            </Button>
          )}
          <ul className="max-h-80 space-y-1 overflow-auto text-sm">
            {v.libraries.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-2 rounded border px-2 py-1">
                <span>
                  v{l.version} · {l.count} examples {l.active && <span className="text-xs text-emerald-700">active</span>}{" "}
                  <span className="text-xs text-muted-foreground">
                    {formatDate(l.createdAt, true)} {l.notes}
                  </span>
                </span>
                {isAdmin && !l.active && (
                  <Button size="xs" variant="outline" onClick={() => post({ action: "activate_library", version: l.version }, "Library version activated")}>
                    Activate
                  </Button>
                )}
              </li>
            ))}
            {v.libraries.length === 0 && <li className="text-muted-foreground">No snapshots yet.</li>}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

type Log = { id: string; action: string; entityType: string; entityId: string | null; timestamp: string; user: { email: string } | null };
function AuditCard() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    api<{ logs: Log[]; total: number }>(`/api/admin/audit?page=${page}`)
      .then((r) => (setLogs(r.logs), setTotal(r.total)))
      .catch((e) => toast.error(e.message));
  }, [page]);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
        <CardDescription>{total.toLocaleString()} events. Includes sign-ins, note views, uploads, reviews, exports and configuration changes.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th>User</th>
              <th>Action</th>
              <th>Entity</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((l) => (
              <tr key={l.id} className="border-t">
                <td className="px-3 py-1 text-xs tabular-nums">{formatDate(l.timestamp, true)}</td>
                <td className="text-xs">{l.user?.email ?? "system"}</td>
                <td className="font-mono text-xs">{l.action}</td>
                <td className="text-xs">
                  {l.entityType} <span className="font-mono text-muted-foreground">{l.entityId}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-end gap-2 p-2">
          <Button size="xs" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Prev
          </Button>
          <Button size="xs" variant="outline" disabled={page * 50 >= total} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
