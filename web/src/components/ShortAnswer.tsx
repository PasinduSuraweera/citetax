/**
 * The short answer at the top of a computed answer, in the model's own words:
 * the result and the main reason for it, before the figures. It was verified
 * with the rest of the explanation, so every figure in it is traced.
 */

export function ShortAnswer({ text }: { text: string }) {
  return <p className="max-w-[64ch] text-[17px] leading-[1.6] text-ink-900">{text}</p>;
}
