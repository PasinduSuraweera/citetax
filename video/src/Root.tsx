import { Composition } from "remotion";
import { HeroLedger, DURATION, FPS } from "./HeroLedger";

export const Root: React.FC = () => (
  <Composition
    id="HeroLedger"
    component={HeroLedger}
    durationInFrames={DURATION}
    fps={FPS}
    width={1200}
    height={1120}
  />
);
