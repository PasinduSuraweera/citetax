/**
 * A demo clip: a question becomes a ledger, line by line, each figure
 * with the law it comes from.
 *
 * Every figure here is read from ledger.json, which scripts/ledger_data.py
 * writes from the real engine at the current corpus snapshot. Nothing in this
 * file is a tax figure.
 */

import { loadFont as loadSans } from "@remotion/google-fonts/IBMPlexSans";
import { loadFont as loadSerif } from "@remotion/google-fonts/SourceSerif4";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import ledger from "./ledger.json";

const { fontFamily: SANS } = loadSans("normal", { weights: ["400", "500", "600"], subsets: ["latin"] });
const { fontFamily: SERIF } = loadSerif("italic", { weights: ["400"], subsets: ["latin"] });

export const FPS = 30;
export const DURATION = 14 * FPS;

const C = {
  night: "#0a1f4c",
  navy: "#012151",
  ink700: "#2c3d5e",
  ink400: "#66728c",
  ink300: "#8791a7",
  line: "#e2e7ef",
  lineFaint: "#eff2f7",
  blue: "#0766d6",
  blue100: "#e2edfc",
  cyan: "#22d3e0",
  gold: "#d9a441",
  amber: "#7e5d1b",
  white: "#ffffff",
};

// Beats, in frames.
const TYPE_FROM = 12;
const TYPE_TO = 92;
const CARD_AT = 104;
const ROW_FROM = 126;
const ROW_EVERY = 30;
// The video plays at about half its size, on a phone smaller still, so it
// shows only the lines that carry a figure. The chat shows every line.
const STEPS = ledger.steps.filter((s) => !s.zero);
const BALANCE_AT = ROW_FROM + ROW_EVERY * STEPS.length + 10;
const VERIFIED_AT = BALANCE_AT + 26;
const FADE_FROM = DURATION - 18;

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

function money(value: number): string {
  return Math.round(value).toLocaleString("en-GB");
}

// A figure appears whole, never counted up: a frame paused mid-count would
// show a number the engine never produced.
function arrive(frame: number, start: number, length = 10): number {
  return interpolate(frame, [start, start + length], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
}

const Composer: React.FC<{ frame: number }> = ({ frame }) => {
  const shown = Math.floor(interpolate(frame, [TYPE_FROM, TYPE_TO], [0, ledger.question.length], clamp));
  const typing = frame < TYPE_TO + 6;
  const caret = typing && Math.floor(frame / 8) % 2 === 0;
  const sent = interpolate(frame, [TYPE_TO + 4, TYPE_TO + 12], [0, 1], clamp);
  return (
    <div
      style={{
        background: C.white,
        borderRadius: 18,
        padding: "22px 26px",
        display: "flex",
        alignItems: "center",
        gap: 18,
        boxShadow: "0 18px 40px -22px rgba(0,0,0,0.55)",
        opacity: interpolate(frame, [0, 10], [0, 1], clamp),
      }}
    >
      <div style={{ flex: 1, fontFamily: SANS, fontSize: 33, lineHeight: 1.35, color: C.navy, minHeight: 90 }}>
        {ledger.question.slice(0, shown)}
        <span style={{ opacity: caret ? 1 : 0, color: C.blue }}>|</span>
      </div>
      <div
        style={{
          width: 64, height: 64, borderRadius: 32, flex: "none",
          background: sent > 0 ? C.blue : C.lineFaint,
          display: "flex", alignItems: "center", justifyContent: "center",
          transform: `scale(${1 + 0.12 * Math.sin(sent * Math.PI)})`,
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={sent > 0 ? C.white : C.ink300} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
      </div>
    </div>
  );
};

const Row: React.FC<{ step: (typeof ledger.steps)[number]; at: number; frame: number; last: boolean }> = ({ step, at, frame, last }) => {
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - at, fps, config: { damping: 200 } });
  const stamp = spring({ frame: frame - at - 8, fps, config: { damping: 14, stiffness: 180 } });
  const shown = arrive(frame, at + 4);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 24,
        padding: "16px 0",
        borderBottom: last ? "none" : `1px solid ${C.lineFaint}`,
        opacity: enter,
        transform: `translateY(${(1 - enter) * 12}px)`,
      }}
    >
      <div>
        <div style={{ fontFamily: SANS, fontSize: 31, fontWeight: 500, color: C.navy }}>{step.label}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 6 }}>
          <span
            style={{
              fontFamily: SERIF,
              fontStyle: "italic",
              fontSize: 25,
              color: C.ink700,
              background: C.lineFaint,
              borderRadius: 8,
              padding: "2px 12px",
              opacity: interpolate(stamp, [0, 1], [0, 1], clamp),
              transform: `scale(${interpolate(stamp, [0, 1], [1.25, 1])})`,
              transformOrigin: "left center",
              whiteSpace: "nowrap",
            }}
          >
            {step.cite}
          </span>
          {step.assumed && (
            <span style={{ fontFamily: SANS, fontSize: 21, color: C.amber, opacity: shown }}>assumed from the salary</span>
          )}
        </div>
      </div>
      <span
        style={{
          fontFamily: SANS,
          fontSize: 34,
          fontWeight: 600,
          color: C.navy,
          fontVariantNumeric: "tabular-nums",
          opacity: shown,
          transform: `translateX(${(1 - shown) * 14}px)`,
          whiteSpace: "nowrap",
        }}
      >
        {money(Number(step.value))}
      </span>
    </div>
  );
};

const Balance: React.FC<{ frame: number }> = ({ frame }) => {
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - BALANCE_AT, fps, config: { damping: 200 } });
  const shown = arrive(frame, BALANCE_AT + 6, 12);
  return (
    <div
      style={{
        marginTop: 18,
        background: C.navy,
        borderRadius: 14,
        padding: "22px 30px",
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        opacity: enter,
        transform: `translateY(${(1 - enter) * 16}px)`,
      }}
    >
      <span style={{ fontFamily: SANS, fontSize: 30, fontWeight: 600, color: C.white }}>Balance payable</span>
      <span
        style={{
          fontFamily: SANS, fontSize: 52, fontWeight: 600, color: C.white, fontVariantNumeric: "tabular-nums",
          opacity: shown, transform: `scale(${0.92 + 0.08 * shown})`, display: "inline-block",
        }}
      >
        <span style={{ fontSize: 30, color: C.cyan, marginRight: 12, fontWeight: 500 }}>LKR</span>
        {money(Number(ledger.balance))}
      </span>
    </div>
  );
};

const Verified: React.FC<{ frame: number }> = ({ frame }) => {
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - VERIFIED_AT, fps, config: { damping: 12, stiffness: 160 } });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 20, opacity: Math.min(1, pop * 1.4) }}>
      <div
        style={{
          width: 46, height: 46, borderRadius: 23, background: C.gold, flex: "none",
          display: "flex", alignItems: "center", justifyContent: "center",
          transform: `scale(${pop})`,
        }}
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={C.navy} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      </div>
      <span style={{ fontFamily: SANS, fontSize: 27, color: C.white }}>
        Verified. Every line cites a rule in force for {ledger.ya}.
      </span>
    </div>
  );
};

export const HeroLedger: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const card = spring({ frame: frame - CARD_AT, fps, config: { damping: 200 } });
  const out = interpolate(frame, [FADE_FROM, DURATION - 1], [1, 0], clamp);

  return (
    <AbsoluteFill style={{ background: C.night }}>
      <AbsoluteFill style={{ padding: "44px 56px", opacity: out }}>
        <Composer frame={frame} />
        <div
          style={{
            marginTop: 26,
            background: C.white,
            borderRadius: 18,
            padding: "14px 32px 10px",
            opacity: card,
            transform: `translateY(${(1 - card) * 24}px)`,
          }}
        >
          <div
            style={{
              display: "flex", justifyContent: "space-between", alignItems: "baseline",
              padding: "8px 0 10px", borderBottom: `1px solid ${C.line}`,
            }}
          >
            <span style={{ fontFamily: SANS, fontSize: 22, color: C.ink400 }}>Year of assessment {ledger.ya}</span>
            <span style={{ fontFamily: SANS, fontSize: 22, color: C.ink400 }}>LKR</span>
          </div>
          {STEPS.map((s, i) => (
            <Row key={s.no} step={s} at={ROW_FROM + i * ROW_EVERY} frame={frame} last={i === STEPS.length - 1} />
          ))}
        </div>
        <Balance frame={frame} />
        <Verified frame={frame} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
