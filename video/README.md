# Demo clips

Short videos of a real Citetax answer, made with [Remotion](https://www.remotion.dev), for demos and social posts. They are not part of the site; the home page uses its own live animation.

Every figure in a clip comes from `src/ledger.json`. `scripts/ledger_data.py` writes that file from the real engine, using the rules in force at the current corpus snapshot, so a clip shows exactly what the chat would answer. Re-render after the law changes.

```
cd video
npm install            # once
npm run data           # recompute src/ledger.json from the engine (needs api/.env)
npm run render         # out/hero.mp4 and out/hero-poster.jpg
npm run studio         # preview and edit
```

## Licence

Remotion is free for individuals and for companies of up to three people; larger companies need a [company licence](https://www.remotion.pro). Check it again if the team grows.
