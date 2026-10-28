"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Upload, Cpu, Search, ClipboardCheck, History, BookOpen, Gauge, Settings, HeartPulse } from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/upload", label: "Upload Data", icon: Upload, minRole: "REVIEWER" },
  { href: "/processing", label: "AI Processing", icon: Cpu },
  { href: "/patients", label: "Patient Search", icon: Search },
  { href: "/review", label: "Complication Review", icon: ClipboardCheck },
  { href: "/validation", label: "Historical Validation", icon: History },
  { href: "/knowledge-base", label: "STS Knowledge Base", icon: BookOpen },
  { href: "/performance", label: "AI Performance", icon: Gauge },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

const RANK = { READ_ONLY: 0, REVIEWER: 1, ADMIN: 2 } as const;

export function AppSidebar({ role }: { role: keyof typeof RANK }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex h-full flex-col gap-1 p-3">
      <Link href="/dashboard" className="mb-4 flex items-center gap-2 px-2 py-1">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <HeartPulse className="size-4" aria-hidden />
        </span>
        <span className="leading-tight">
          <span className="block text-sm font-semibold">STS Complications</span>
          <span className="block text-[11px] text-muted-foreground">Children&apos;s Nebraska</span>
        </span>
      </Link>
      {NAV.filter((n) => !("minRole" in n) || RANK[role] >= RANK[n.minRole]).map((n) => {
        const active = pathname === n.href || pathname.startsWith(`${n.href}/`);
        const Icon = n.icon;
        return (
          <Link
            key={n.href}
            href={n.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900",
              active && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}
