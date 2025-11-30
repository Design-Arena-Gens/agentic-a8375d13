/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Engine = "Veo3" | "Sora2";

type Resolution = {
  label: string;
  width: number;
  height: number;
};

type HistoryItem = {
  id: string;
  engine: Engine;
  prompt: string;
  duration: number;
  width: number;
  height: number;
  url: string;
  createdAt: number;
};

function seededRandom(seed: number) {
  // Mulberry32
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToInt(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return h >>> 0;
}

function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") return initial;
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }, [key, value]);
  return [value, setValue] as const;
}

export default function Page() {
  const [prompt, setPrompt] = useState("");
  const [engine, setEngine] = useState<Engine>("Veo3");
  const resolutions = useMemo<Resolution[]>(
    () => [
      { label: "Square 512x512", width: 512, height: 512 },
      { label: "Portrait 576x1024", width: 576, height: 1024 },
      { label: "Landscape 768x432", width: 768, height: 432 },
      { label: "HD 1280x720", width: 1280, height: 720 }
    ],
    []
  );
  const [resIdx, setResIdx] = useState(2);
  const [duration, setDuration] = useState(5);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [history, setHistory] = useLocalStorage<HistoryItem[]>("history.videos", []);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);

  const activeRes = resolutions[resIdx];

  const clearStream = () => {
    mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    mediaRecorderRef.current = null;
  };

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      clearStream();
    };
  }, []);

  const drawFrameVeo = (
    ctx: CanvasRenderingContext2D,
    t: number,
    seedFn: () => number,
    w: number,
    h: number,
    text: string
  ) => {
    // Veo3 style: neon volumetric fog + particles
    ctx.clearRect(0, 0, w, h);

    // Background gradient fog layers
    for (let i = 0; i < 5; i++) {
      const p = (i + 1) / 5;
      const x = Math.sin(t * 0.3 + i) * w * 0.3 + w * 0.5;
      const y = Math.cos(t * 0.25 + i * 1.7) * h * 0.25 + h * 0.5;
      const r = Math.max(w, h) * (0.6 + 0.6 * p);
      const g = ctx.createRadialGradient(x, y, r * 0.0, x, y, r);
      const hue = 250 + 60 * Math.sin(t * 0.2 + i);
      g.addColorStop(0, `hsla(${hue}, 95%, 65%, 0.10)`);
      g.addColorStop(1, `hsla(${hue + 40}, 90%, 55%, 0.00)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Particles
    const pr = 120;
    for (let i = 0; i < pr; i++) {
      const a = i / pr;
      const radius = 0.18 + 0.65 * a;
      const angle = t * (0.6 + 0.5 * a) + i * 0.21;
      const x = w * 0.5 + Math.cos(angle) * w * radius * 0.35;
      const y = h * 0.5 + Math.sin(angle * 1.2) * h * radius * 0.35;
      const size = 2 + 3 * a;
      const hue = 200 + 100 * a;
      ctx.fillStyle = `hsla(${hue}, 90%, ${60 + 20 * Math.sin(angle)}%, ${0.35 - 0.3 * a})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }

    // Prompt text glow
    ctx.save();
    ctx.font = `${Math.max(18, Math.min(w, h) * 0.045)}px ui-sans-serif, system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tx = w * 0.5;
    const ty = h * 0.85;
    ctx.shadowColor = "rgba(124,92,255,0.9)";
    ctx.shadowBlur = 24;
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillText(text, tx, ty);
    ctx.restore();

    // Letterboxing with soft edges
    const lb = Math.max(8, Math.min(w, h) * 0.015);
    const grad = ctx.createLinearGradient(0, 0, 0, lb);
    grad.addColorStop(0, "rgba(0,0,0,0.6)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, lb);
    ctx.save();
    const grad2 = ctx.createLinearGradient(0, h - lb, 0, h);
    grad2.addColorStop(0, "rgba(0,0,0,0)");
    grad2.addColorStop(1, "rgba(0,0,0,0.6)");
    ctx.fillStyle = grad2;
    ctx.fillRect(0, h - lb, w, lb);
    ctx.restore();
  };

  const drawFrameSora = (
    ctx: CanvasRenderingContext2D,
    t: number,
    rand: () => number,
    w: number,
    h: number,
    text: string
  ) => {
    // Sora2 style: cinematic camera moves over 3D-ish shapes
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#04070a";
    ctx.fillRect(0, 0, w, h);

    // Moving directional light sweep
    const sweep = ctx.createLinearGradient(0, 0, w, h);
    const baseHue = 200 + 40 * Math.sin(t * 0.2);
    sweep.addColorStop(0, `hsla(${baseHue}, 100%, 60%, 0.10)`);
    sweep.addColorStop(1, `hsla(${baseHue + 100}, 100%, 60%, 0.04)`);
    ctx.fillStyle = sweep;
    ctx.fillRect(0, 0, w, h);

    // Layered rotating squares (simulate parallax)
    const layers = 9;
    for (let i = 0; i < layers; i++) {
      const a = i / layers;
      const size = Math.min(w, h) * (0.15 + a * 0.55);
      const cx = w * 0.5 + Math.sin(t * (0.4 + a * 0.3)) * w * 0.18 * (1 - a);
      const cy = h * 0.5 + Math.cos(t * (0.35 + a * 0.25)) * h * 0.16 * (1 - a);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * (0.25 + a * 0.45) + i);
      const grd = ctx.createLinearGradient(-size, -size, size, size);
      grd.addColorStop(0, `hsla(${180 + 40 * a}, 90%, ${25 + 50 * a}%, ${0.65 - 0.06 * i})`);
      grd.addColorStop(1, `hsla(${220 + 60 * a}, 90%, ${15 + 45 * a}%, ${0.65 - 0.06 * i})`);
      ctx.fillStyle = grd;
      const r = size * (0.8 + 0.2 * Math.sin(t + i));
      ctx.fillRect(-r, -r, r * 2, r * 2);
      ctx.restore();
    }

    // Bokeh dots
    for (let i = 0; i < 50; i++) {
      const p = i / 50;
      const x = (rand() * 1.2 - 0.1 + Math.sin(t * 0.3 + i) * 0.02) * w;
      const y = (rand() * 1.2 - 0.1 + Math.cos(t * 0.25 + i) * 0.02) * h;
      const r = 1 + 3 * p;
      ctx.fillStyle = `rgba(255,255,255,${0.06 + 0.06 * Math.sin(t + i)})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Prompt text with cinematic subtitle style
    ctx.save();
    ctx.font = `${Math.max(18, Math.min(w, h) * 0.05)}px ui-sans-serif, system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 4;
    const tx = w * 0.5;
    const ty = h * 0.85;
    ctx.strokeText(text, tx, ty);
    ctx.fillText(text, tx, ty);
    ctx.restore();
  };

  const generate = useCallback(async () => {
    setIsGenerating(true);
    setProgress(0);
    setCurrentUrl(null);

    const { width, height } = activeRes;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvasRef.current = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setIsGenerating(false);
      return;
    }

    // Recorder
    const stream = canvas.captureStream(30);
    const recorder = new MediaRecorder(stream, {
      mimeType:
        MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
          ? "video/webm;codecs=vp9"
          : "video/webm"
    });
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    const recordingPromise = new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(chunksRef.current, { type: recorder.mimeType }));
      };
    });
    mediaRecorderRef.current = recorder;
    recorder.start();

    // Animation
    const total = Math.max(1, duration);
    const start = performance.now();
    const seed = hashStringToInt(prompt + engine + width + "x" + height);
    const rand = seededRandom(seed);
    const text = (prompt || "Untitled").slice(0, 80);

    const tick = () => {
      const now = performance.now();
      const elapsed = (now - start) / 1000;
      const t = elapsed;
      const p = Math.min(1, elapsed / total);
      setProgress(Math.floor(p * 100));
      if (engine === "Veo3") {
        drawFrameVeo(ctx, t, rand, width, height, text);
      } else {
        drawFrameSora(ctx, t, rand, width, height, text);
      }
      if (elapsed < total) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        recorder.stop();
      }
    };

    tick();
    const blob = await recordingPromise;
    clearStream();
    const url = URL.createObjectURL(blob);
    setCurrentUrl(url);

    const item: HistoryItem = {
      id: String(Date.now()),
      engine,
      prompt: prompt || "Untitled",
      duration: total,
      width,
      height,
      url,
      createdAt: Date.now()
    };
    setHistory((h) => [item, ...h].slice(0, 12));

    setIsGenerating(false);
    setProgress(100);
  }, [activeRes, duration, engine, prompt, setHistory]);

  const downloadCurrent = () => {
    if (!currentUrl) return;
    const a = document.createElement("a");
    a.href = currentUrl;
    a.download = `${engine}-${activeRes.width}x${activeRes.height}-${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <div className="container">
      <div className="header">
        <div className="logo" aria-hidden>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L21 7V17L12 22L3 17V7L12 2Z" fill="white" opacity="0.9"></path>
            <path d="M12 5L18 8.5V15.5L12 19L6 15.5V8.5L12 5Z" fill="url(#g)"></path>
            <defs>
              <linearGradient id="g" x1="0" y1="0" x2="24" y2="24">
                <stop stopColor="#7C5CFF" />
                <stop offset="1" stopColor="#00D4FF" />
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div>
          <div className="title">Agentic Video Generator</div>
          <div className="subtitle">Create videos with Veo3 and Sora2 styles ? free, unlimited</div>
        </div>
      </div>

      <div className="grid">
        <div className="panel">
          <div className="field">
            <label className="label">Prompt</label>
            <textarea
              className="input"
              placeholder="e.g., A starship gliding through a neon galaxy, cinematic lighting, smooth camera orbit"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
            />
          </div>
          <div className="row">
            <div className="field">
              <label className="label">Engine</label>
              <select
                className="select"
                value={engine}
                onChange={(e) => setEngine(e.target.value as Engine)}
              >
                <option value="Veo3">Veo3</option>
                <option value="Sora2">Sora2</option>
              </select>
            </div>
            <div className="field">
              <label className="label">Resolution</label>
              <select
                className="select"
                value={String(resIdx)}
                onChange={(e) => setResIdx(Number(e.target.value))}
              >
                {resolutions.map((r, i) => (
                  <option key={r.label} value={i}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label">Duration: {duration}s</label>
              <input
                className="slider"
                type="range"
                min={2}
                max={12}
                step={1}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
            <button
              className="button"
              onClick={generate}
              disabled={isGenerating || !prompt.trim()}
            >
              {isGenerating ? "Generating..." : "Generate"}
            </button>
            <button
              className="button ghost"
              onClick={() => {
                setPrompt("");
              }}
              disabled={isGenerating}
            >
              Clear
            </button>
            <button
              className="button"
              onClick={downloadCurrent}
              disabled={!currentUrl}
              title="Download current video"
            >
              Download
            </button>
          </div>

          <div style={{ height: 14 }} />
          <div className="progress">
            <div className="bar" style={{ width: `${progress}%` }} />
          </div>
          <div style={{ marginTop: 8 }} className="muted">
            {isGenerating
              ? "Rendering frames in your browser..."
              : currentUrl
              ? "Done. You can preview or download your video below."
              : "Enter a prompt and press Generate."}
          </div>
        </div>

        <div className="panel">
          <div className="canvasWrap">
            {currentUrl ? (
              <video className="preview" src={currentUrl} controls autoPlay loop muted />
            ) : (
              <div className="muted">Your video preview will appear here</div>
            )}
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
            <span className="tag">{engine}</span>
            <span className="tag">
              {activeRes.width}?{activeRes.height}
            </span>
            <span className="tag">{duration}s</span>
          </div>
        </div>
      </div>

      <div style={{ height: 18 }} />
      <div className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div className="title" style={{ fontSize: 16 }}>Recent videos</div>
          <button
            className="button smallBtn danger"
            onClick={() => setHistory([])}
            disabled={history.length === 0}
          >
            Clear history
          </button>
        </div>
        <div style={{ height: 10 }} />
        <div className="history">
          {history.map((h) => (
            <div className="card" key={h.id}>
              <video src={h.url} controls muted loop />
              <div className="meta">
                <span className="tag">{h.engine}</span>
                <button
                  className="button smallBtn"
                  onClick={() => {
                    const a = document.createElement("a");
                    a.href = h.url;
                    a.download = `${h.engine}-${h.width}x${h.height}-${h.createdAt}.webm`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                  }}
                >
                  Download
                </button>
              </div>
            </div>
          ))}
          {history.length === 0 && (
            <div className="muted">No videos yet. Generate your first above.</div>
          )}
        </div>
      </div>
    </div>
  );
}

