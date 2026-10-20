"use client";

import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import {
  SEVERITY_LABEL,
  SOURCE_LABEL,
  STATUS_LABEL,
  type AlertSource,
  type AlertStatus,
  type Severity,
} from "@/lib/risk";

export function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ icons */

type IconName =
  | "alert"
  | "network"
  | "beaker"
  | "refresh"
  | "search"
  | "close"
  | "chevron-left"
  | "chevron-right"
  | "arrow-right"
  | "circle"
  | "half"
  | "check"
  | "warning"
  | "info"
  | "fit"
  | "expand";

const ICON_PATHS: Record<IconName, ReactNode> = {
  alert: <path d="M8 1.5 1 14h14L8 1.5Zm0 4.5v4m0 2v.5" />,
  network: (
    <>
      <circle cx="3.5" cy="4" r="2" />
      <circle cx="12.5" cy="4" r="2" />
      <circle cx="8" cy="12.5" r="2" />
      <path d="M5.5 4h5M4.6 5.7l2.4 5M11.4 5.7 9 10.7" />
    </>
  ),
  beaker: <path d="M6 1.5h4M6.5 1.5v5L2 14.5h12l-4.5-8v-5M4.2 10.5h7.6" />,
  refresh: <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" />
    </>
  ),
  close: <path d="m3.5 3.5 9 9m0-9-9 9" />,
  "chevron-left": <path d="M10 3 5 8l5 5" />,
  "chevron-right": <path d="m6 3 5 5-5 5" />,
  "arrow-right": <path d="M2.5 8h11m-4-4 4 4-4 4" />,
  circle: <circle cx="8" cy="8" r="5.5" />,
  half: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5v11a5.5 5.5 0 0 0 0-11Z" fill="currentColor" />
    </>
  ),
  check: <path d="m3 8.5 3.2 3L13 4.5" />,
  warning: <path d="M8 1.5 1 14h14L8 1.5Zm0 4.5v4m0 2v.5" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 7v4.5M8 4.5V5" />
    </>
  ),
  fit: <path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5" />,
  expand: <path d="M8 2.5v11M2.5 8h11" />,
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cx("h-4 w-4 shrink-0", className)}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/* ---------------------------------------------------------------- buttons */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-white border-accent hover:bg-accent-hover hover:border-accent-hover",
  secondary: "bg-surface text-ink border-line-strong hover:bg-sunken",
  ghost: "bg-transparent text-ink-2 border-transparent hover:bg-sunken hover:text-ink",
  danger: "bg-surface text-danger border-danger/40 hover:bg-danger-soft",
};

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  busy?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", busy, disabled, className, children, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap",
        "transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-55",
        size === "sm" ? "h-8 px-2.5 text-[0.8125rem]" : "h-9 px-3.5 text-sm",
        BUTTON_STYLES[variant],
        className
      )}
      {...props}
    >
      {busy && <Spinner />}
      {children}
    </button>
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent",
        className
      )}
    />
  );
}

/* ----------------------------------------------------------------- badges */

const SEVERITY_STYLES: Record<Severity, string> = {
  critical: "bg-risk-critical-soft text-risk-critical border-risk-critical/30",
  high: "bg-risk-high-soft text-risk-high border-risk-high/30",
  medium: "bg-risk-medium-soft text-risk-medium border-risk-medium/30",
  low: "bg-risk-low-soft text-risk-low border-risk-low/30",
};

// Bar count gives severity a non-colour encoding.
const SEVERITY_BARS: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export function SeverityBadge({ severity }: { severity: Severity | null }) {
  if (!severity) {
    return <span className="text-ink-3">Unrated</span>;
  }

  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-xs font-medium",
        SEVERITY_STYLES[severity]
      )}
    >
      <span aria-hidden="true" className="flex items-end gap-px">
        {[1, 2, 3, 4].map((bar) => (
          <span
            key={bar}
            className={cx(
              "w-[3px] rounded-[1px]",
              bar <= SEVERITY_BARS[severity] ? "bg-current" : "bg-current/20"
            )}
            style={{ height: 3 + bar * 2 }}
          />
        ))}
      </span>
      {SEVERITY_LABEL[severity]}
    </span>
  );
}

const STATUS_ICON: Record<AlertStatus, IconName> = {
  open: "circle",
  investigating: "half",
  resolved: "check",
};

export function StatusBadge({ status }: { status: AlertStatus | null }) {
  if (!status) return <span className="text-ink-3">Unknown</span>;

  return (
    <span className="inline-flex items-center gap-1.5 text-[0.8125rem] text-ink-2">
      <Icon
        name={STATUS_ICON[status]}
        className={cx(
          "h-3.5 w-3.5",
          status === "open" && "text-accent",
          status === "investigating" && "text-warn",
          status === "resolved" && "text-ok"
        )}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function SourceBadge({ source }: { source: AlertSource }) {
  const truth = source === "ground_truth_demo";

  return (
    <span
      className={cx(
        "inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-medium",
        truth
          ? "border-dashed border-truth/50 bg-truth-soft text-truth"
          : "border-line-strong bg-surface text-ink-2"
      )}
    >
      {SOURCE_LABEL[source]}
    </span>
  );
}

/* ---------------------------------------------------------- page sections */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-5">
      <div className="min-w-0 max-w-3xl">
        <h1 className="text-xl font-semibold tracking-[-0.01em] text-ink">{title}</h1>
        {description && <p className="mt-1 text-ink-2">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("rounded-lg border border-line bg-surface", className)}>
      {children}
    </section>
  );
}

type NoticeTone = "danger" | "warn" | "info" | "ok";

const NOTICE_STYLES: Record<NoticeTone, string> = {
  danger: "border-danger/30 bg-danger-soft text-danger",
  warn: "border-warn/30 bg-warn-soft text-warn",
  info: "border-line bg-sunken text-ink-2",
  ok: "border-ok/30 bg-ok-soft text-ok",
};

const NOTICE_ICON: Record<NoticeTone, IconName> = {
  danger: "warning",
  warn: "warning",
  info: "info",
  ok: "check",
};

export function Notice({
  tone,
  title,
  children,
  action,
  className,
}: {
  tone: NoticeTone;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cx("flex items-start gap-3 rounded-md border px-3.5 py-3", NOTICE_STYLES[tone], className)}
    >
      <Icon name={NOTICE_ICON[tone]} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cx(title && "mt-0.5", "text-ink-2")}>{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <p className="font-medium text-ink">{title}</p>
      {children && <p className="mt-1 max-w-md text-ink-2">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx("block animate-shimmer rounded-sm bg-sunken", className)} />;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-[0.8125rem] font-medium text-ink">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {error ? (
        <p id={`${htmlFor}-error`} className="mt-1 text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="mt-1 text-xs text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass = cx(
  "h-9 w-full rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink",
  "placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20",
  "disabled:cursor-not-allowed disabled:bg-sunken aria-[invalid=true]:border-danger"
);

/* ----------------------------------------------------------------- drawer */

/**
 * Side drawer built on <dialog>, which supplies focus trapping, Escape to
 * close, inert background content and focus return without extra code.
 */
export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label={title}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={cx(
        "m-0 ml-auto h-dvh max-h-dvh w-full max-w-[34rem] border-l border-line bg-surface p-0 text-ink",
        "shadow-overlay open:flex open:flex-col"
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <h2 className="truncate text-base font-semibold">{title}</h2>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close panel">
          <Icon name="close" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      {footer && <div className="border-t border-line bg-canvas px-5 py-3">{footer}</div>}
    </dialog>
  );
}

/* ---------------------------------------------------------- data display */

export function DataList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2.5">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="text-ink-3">{item.label}</dt>
          <dd className="min-w-0 break-words text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[0.8125rem]", className)}>{children}</span>;
}

/** Static-shell placeholder for pages that read URL state on the client. */
export function PageFallback({ title }: { title: string }) {
  return (
    <div role="status" aria-label={`Loading ${title}`}>
      <div className="pb-5">
        <p className="text-xl font-semibold tracking-[-0.01em] text-ink">{title}</p>
        <Skeleton className="mt-2 h-4 w-72" />
      </div>
      <div className="rounded-lg border border-line bg-surface p-4">
        <Skeleton className="h-8 w-full max-w-md" />
        <Skeleton className="mt-4 h-48 w-full" />
      </div>
    </div>
  );
}
