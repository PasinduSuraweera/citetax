/**
 * The short answer at the top of a computed answer, in the model's own words:
 * the result and the main reason for it, before the figures. It was verified
 * with the rest of the explanation, so every figure in it is traced.
 *
 * A hairline across the answer sets it apart from the question and its tags.
 */

export function ShortAnswer({ text }: { text: string }) {
  return (
    <div className="mt-1 border-t border-line pt-5">
      <p className="max-w-[64ch] text-[17px] leading-[1.6] text-ink-900">{text}</p>
    </div>
  );
}
