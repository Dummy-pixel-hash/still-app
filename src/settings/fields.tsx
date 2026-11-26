import { useId, type ReactNode } from "react"

export const inputClass =
  "w-full rounded-lg border border-white/10 bg-black/50 px-3 py-2 text-[13px] text-fg transition placeholder:text-faint/70 focus:border-white/30"

export const buttonClass =
  "rounded-full bg-white/[0.08] px-4 py-1.5 text-[13px] text-fg transition hover:bg-white/[0.14] disabled:opacity-40"

/** A native label (visible text) wired to its control, with an optional hint. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: (props: { id: string; describedBy?: string }) => ReactNode
}) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  return (
    <div className="block">
      <label htmlFor={id} className="mb-1 block text-xs text-dim">
        {label}
      </label>
      {children({ id, describedBy: hintId })}
      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-dim">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: ReactNode
  checked: boolean
  onChange: (next: boolean) => void
}) {
  const id = useId()
  const hintId = hint ? `${id}-hint` : undefined
  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-2 text-[13px] text-fg">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          aria-describedby={hintId}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-[#d8d2dc]"
        />
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="ml-6 mt-1 text-xs text-dim">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export function SettingBlock({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="border-t border-white/[0.07] py-5 first:border-t-0 first:pt-0">
      <h3 id={`${id}-title`} className="text-[14px] font-medium text-fg">
        {title}
      </h3>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  )
}
