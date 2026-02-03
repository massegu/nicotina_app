import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * V1.1 — Estilo “Stahl” + parámetro visible: ventana ~45 min desensibilizado
 *
 * Cambios clave:
 * - Se expone “Ventana desensibilización (min)” (por defecto 45).
 * - El modelo usa esa ventana como tiempo característico de recuperación (1/ventana).
 *
 * Nota: Modelo conceptual para docencia (no clínico).
 */

// ---------- Wireframe visual (V1.1) ----------
// ┌──────────────────────────────────────────────────────────────────────────┐
// │ Header: título + chips (nicotina, α7 ACh/Glu, α4β2 DA/GABA, tiempo)       │
// ├───────────────────────────────────────────────┬──────────────────────────┤
// │ Panel central (SVG estilo Stahl)             │ Controles (modo clase)      │
// │ - ACh (α7 pre) ┐                              │ - Presets (3)              │
// │ - Glu (α7 pre) ├─▶ DA (α4β2 post) ─▶ NAcc     │ - Puff                     │
// │ - GABA (α4β2) ┘   ▲                            │ - Frecuencia               │
// │   (vía indirecta)   └─ inhibición (GABA)       │ - +60 min                  │
// ├───────────────────────────────────────────────┴──────────────────────────┤
// │ Indicadores + timeline: DA, GABA, desens DA/GABA, nicotina                │
// └──────────────────────────────────────────────────────────────────────────┘

// ---------- Helpers ----------
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

type Alpha4b2State = "basal" | "activado" | "desensibilizado";

type ModelParams = {
  nicotineHalfLifeMin: number; // proxy
  actThreshold: number;
  desensRateDA: number;
  desensRateGABA: number;
  alpha7Threshold: number;
  desensWindowMin: number; // NUEVO: ventana típica de desensibilización (~45 min)
};

const DEFAULT_PARAMS: ModelParams = {
  nicotineHalfLifeMin: 120,
  actThreshold: 0.15,
  desensRateDA: 0.03,
  desensRateGABA: 0.04,
  alpha7Threshold: 0.08,
  desensWindowMin: 45,
};

type ReceptorPool = { basal: number; activado: number; desens: number };

function normalizePool(p: ReceptorPool): ReceptorPool {
  const s = p.basal + p.activado + p.desens;
  if (s <= 0) return { basal: 1, activado: 0, desens: 0 };
  return { basal: p.basal / s, activado: p.activado / s, desens: p.desens / s };
}

function receptorColor(state: Alpha4b2State) {
  switch (state) {
    case "basal":
      return "#94a3b8";
    case "activado":
      return "#16a34a";
    case "desensibilizado":
      return "#b91c1c";
    default:
      return "#94a3b8";
  }
}

function poolToState(p: ReceptorPool): Alpha4b2State {
  if (p.desens >= p.basal && p.desens >= p.activado) return "desensibilizado";
  if (p.activado >= p.basal && p.activado >= p.desens) return "activado";
  return "basal";
}

function stepAlpha4b2(
  dtMin: number,
  nic: number,
  pool: ReceptorPool,
  params: ModelParams,
  desensRate: number,
) {
  let p = { ...pool };

  // Recuperación definida por ventana: si ventana=45 min, recover≈1/45 por min
  // (tiempo característico; en un modelo de fracciones esto es didáctico pero muy útil)
  const recoverRate = 1 / Math.max(1, params.desensWindowMin);

  const nicDrive = clamp01(
    (nic - params.actThreshold) / (1 - params.actThreshold),
  );
  const toActive =
    p.basal * (nic > params.actThreshold ? 0.25 * nicDrive : 0) * dtMin;
  p.basal -= toActive;
  p.activado += toActive;

  const toDesens =
    p.activado * (nic > params.actThreshold ? desensRate : 0) * dtMin;
  p.activado -= toDesens;
  p.desens += toDesens;

  // Recuperación: más rápida cuando nicotina está baja; más lenta si sigue alta
  const lowNic = nic < params.actThreshold * 0.9;
  const k = lowNic ? recoverRate : recoverRate * 0.35;
  const toBasal = p.desens * k * dtMin;
  p.desens -= toBasal;
  p.basal += toBasal;

  return normalizePool(p);
}

type ModelOut = {
  nicotine: number;
  alpha7AchOn: boolean;
  alpha7GluOn: boolean;
  achDrive: number;
  gluDrive: number;
  poolDA: ReceptorPool;
  poolGABA: ReceptorPool;
  gaba: number;
  da: number;
  direct: number;
  indirect: number;
};

function stepModel(
  dtMin: number,
  nicotine: number,
  poolDA: ReceptorPool,
  poolGABA: ReceptorPool,
  puffNow: boolean,
  params: ModelParams,
): ModelOut {
  // 1) Entrada + decaimiento nicotina
  let nic = nicotine;
  if (puffNow) nic = clamp01(nic + 0.25);

  const decay = Math.pow(0.5, dtMin / params.nicotineHalfLifeMin);
  nic = clamp01(nic * decay);

  // 2) α7 presinápticos separados
  const alpha7AchOn = nic > params.alpha7Threshold;
  const alpha7GluOn = nic > params.alpha7Threshold;

  // Drives (proxies): facilitan entrada excitatoria hacia DA
  const achDrive = clamp01(0.35 + (alpha7AchOn ? 0.45 * nic : 0.05));
  const gluDrive = clamp01(0.3 + (alpha7GluOn ? 0.55 * nic : 0.05));

  // 3) α4β2 explícito en DA (vía directa) y en GABA (vía indirecta)
  const nextPoolDA = stepAlpha4b2(
    dtMin,
    nic,
    poolDA,
    params,
    params.desensRateDA,
  );
  const nextPoolGABA = stepAlpha4b2(
    dtMin,
    nic,
    poolGABA,
    params,
    params.desensRateGABA,
  );

  // 4) Vía directa / indirecta
  const direct = clamp01(
    0.15 + 0.95 * nextPoolDA.activado * (0.55 * achDrive + 0.65 * gluDrive),
  );

  // GABA alto cuando activación GABA-α4β2, bajo cuando desensibilizado
  const gaba = clamp01(
    0.25 + 0.95 * nextPoolGABA.activado - 0.85 * nextPoolGABA.desens,
  );
  const indirect = clamp01(0.15 + 0.9 * (1 - gaba));

  // Dopamina final
  const da = clamp01(0.1 + 0.75 * direct + 0.35 * indirect);

  return {
    nicotine: nic,
    alpha7AchOn,
    alpha7GluOn,
    achDrive,
    gluDrive,
    poolDA: nextPoolDA,
    poolGABA: nextPoolGABA,
    gaba,
    da,
    direct,
    indirect,
  };
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 border border-slate-200">
      {children}
    </span>
  );
}

function Bar({ label, value }: { label: string; value: number }) {
  const v = clamp01(value);
  return (
    <div className="flex items-center gap-3">
      <div className="w-44 text-sm text-slate-600">{label}</div>

      <div className="flex-1 h-3 rounded-full bg-slate-200 overflow-hidden">
        <div
          className="h-3 rounded-full bg-slate-700 transition-[width] duration-150 ease-out"
          style={{ width: `${v * 100}%` }} // 👈 sin Math.round aquí
        />
      </div>

      <div className="w-12 text-right text-sm tabular-nums text-slate-700">
        {Math.round(v * 100)}%
      </div>
    </div>
  );
}

type Preset = "puff" | "repetido" | "abstinencia";

function RecoveryClock({
  cx,
  cy,
  r,
  startMin,
  nowMin,
  windowMin,
  color = "#7c3aed",
  track = "#cbd5e1",
  labelDy = -38, // sube/baja la etiqueta
}: {
  cx: number;
  cy: number;
  r: number;
  startMin: number | null;
  nowMin: number;
  windowMin: number;
  color?: string;
  track?: string;
  labelDy?: number;
}) {
  if (startMin == null) return null;

  const win = Math.max(1, windowMin);
  const elapsed = Math.max(0, nowMin - startMin);
  const progress = clamp01(elapsed / win);

  const remaining = Math.max(0, Math.ceil(win - elapsed));

  const C = 2 * Math.PI * r;
  const dash = C * progress;
  const gap = C - dash;

  // aguja (tipo reloj)
  const angle = -Math.PI / 2 + progress * 2 * Math.PI;
  const hx = cx + Math.cos(angle) * (r - 2);
  const hy = cy + Math.sin(angle) * (r - 2);

  return (
    <g>
      {/* pista */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={track}
        strokeWidth={6}
        opacity={0.85}
      />

      {/* progreso */}
      <circle
        cx={cx}
        cy={cy}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={6}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${gap}`}
        transform={`rotate(-90 ${cx} ${cy})`}
        style={{ animation: "pulse 1.2s ease-in-out infinite" }}
      />

      {/* aguja */}
      <line
        x1={cx}
        y1={cy}
        x2={hx}
        y2={hy}
        stroke={color}
        strokeWidth={2}
        opacity={0.9}
      />

      {/* etiqueta minutos restantes (arriba) */}
      <rect
        x={cx - 26}
        y={cy + labelDy - 14}
        width={52}
        height={20}
        rx={8}
        fill="#ffffff"
        stroke="#e2e8f0"
      />
      <text
        x={cx}
        y={cy + labelDy}
        textAnchor="middle"
        fontSize="11"
        fill={color}
        fontWeight="800"
        className="tabular-nums"
      >
        {remaining} min
      </text>
    </g>
  );
}

export default function NicotineCircuitV11() {
  const [params, setParams] = useState<ModelParams>(DEFAULT_PARAMS);

  // estado del modelo
  const [nicotine, setNicotine] = useState(0);
  const [poolDA, setPoolDA] = useState<ReceptorPool>({
    basal: 1,
    activado: 0,
    desens: 0,
  });
  const [poolGABA, setPoolGABA] = useState<ReceptorPool>({
    basal: 1,
    activado: 0,
    desens: 0,
  });

  const [alpha7AchOn, setAlpha7AchOn] = useState(false);
  const [alpha7GluOn, setAlpha7GluOn] = useState(false);
  const [achDrive, setAchDrive] = useState(0.35);
  const [gluDrive, setGluDrive] = useState(0.3);

  const [gaba, setGaba] = useState(0.5);
  const [da, setDa] = useState(0.2);
  const [direct, setDirect] = useState(0.2);
  const [indirect, setIndirect] = useState(0.2);

  //const [puffTimes, setPuffTimes] = useState<number[]>([]);

  const [puffsPerMin, setPuffsPerMin] = useState(0);
  const [preset, setPreset] = useState<Preset>("puff");

  const [isRunning, setIsRunning] = useState(true);
  const [simMin, setSimMin] = useState(0);

  const rafRef = useRef<number | null>(null);
  const lastT = useRef<number | null>(null);

  const [desensStartDA, setDesensStartDA] = useState<number | null>(null);
  const [desensStartG, setDesensStartG] = useState<number | null>(null);

  const [trace, setTrace] = useState<
    {
      t: number;
      da: number;
      gaba: number;
      nic: number;
      desAll: number;
      puff: boolean;
    }[]
  >([]);

  const stateDA = useMemo(() => poolToState(poolDA), [poolDA]);
  const stateG = useMemo(() => poolToState(poolGABA), [poolGABA]);

  const resetTimeline = () => {
    setTrace([]);
    setSimMin(0);
    lastT.current = null;

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const applyPreset = (p: Preset) => {
    resetTimeline();
    setPreset(p);

    if (p === "puff") {
      setPuffsPerMin(0);
      setNicotine(0);
      setPoolDA({ basal: 1, activado: 0, desens: 0 });
      setPoolGABA({ basal: 1, activado: 0, desens: 0 });
    }

    if (p === "repetido") {
      setPuffsPerMin(0.18);
      setNicotine(0);
      setPoolDA({ basal: 1, activado: 0, desens: 0 });
      setPoolGABA({ basal: 1, activado: 0, desens: 0 });
    }

    if (p === "abstinencia") {
      setPuffsPerMin(0);
      setNicotine(0.02);
      setPoolDA(normalizePool({ basal: 0.35, activado: 0.05, desens: 0.6 }));
      setPoolGABA(normalizePool({ basal: 0.4, activado: 0.05, desens: 0.55 }));
    }
  };

  const reset = () => {
    setNicotine(0);
    setPoolDA({ basal: 1, activado: 0, desens: 0 });
    setPoolGABA({ basal: 1, activado: 0, desens: 0 });
    setAlpha7AchOn(false);
    setAlpha7GluOn(false);
    setAchDrive(0.35);
    setGluDrive(0.3);
    setGaba(0.5);
    setDa(0.2);
    setDirect(0.2);
    setIndirect(0.2);
    setPuffsPerMin(0);
    setPreset("puff");
    setSimMin(0);
    setTrace([]);
  };

  const doPuff = () => {
    const out = stepModel(0, nicotine, poolDA, poolGABA, true, params);
    setNicotine(out.nicotine);
    setPoolDA(out.poolDA);
    setPoolGABA(out.poolGABA);
    setAlpha7AchOn(out.alpha7AchOn);
    setAlpha7GluOn(out.alpha7GluOn);
    setAchDrive(out.achDrive);
    setGluDrive(out.gluDrive);
    setGaba(out.gaba);
    setDa(out.da);
    setDirect(out.direct);
    setIndirect(out.indirect);
  };

  const advance60 = () => {
    let nic = nicotine;
    let pDA = poolDA;
    let pG = poolGABA;
    let t = simMin;

    const newTrace: typeof trace = [];
    let out: ModelOut | null = null;
    for (let i = 0; i < 60; i++) {
      out = stepModel(1, nic, pDA, pG, false, params);
      nic = out.nicotine;
      pDA = out.poolDA;
      pG = out.poolGABA;
      t += 1;
      const desAll = clamp01(
        0.5 * out.poolDA.desens + 0.5 * out.poolGABA.desens,
      );
      newTrace.push({
        t,
        da: out.da,
        gaba: out.gaba,
        nic: out.nicotine,
        desAll,
        puff: true,
      });
    }

    if (out) {
      setNicotine(nic);
      setPoolDA(pDA);
      setPoolGABA(pG);
      setAlpha7AchOn(out.alpha7AchOn);
      setAlpha7GluOn(out.alpha7GluOn);
      setAchDrive(out.achDrive);
      setGluDrive(out.gluDrive);
      setGaba(out.gaba);
      setDa(out.da);
      setDirect(out.direct);
      setIndirect(out.indirect);
      setSimMin(t);
      setTrace((prev) => [...prev, ...newTrace].slice(-900));
    }
  };

  useEffect(() => {
    if (!isRunning) return;

    const tick = (ts: number) => {
      if (lastT.current == null) lastT.current = ts;
      const dtMs = ts - lastT.current;
      lastT.current = ts;

      // 1s real = 1 min sim
      const dtMin = dtMs / 1000;

      const prob = clamp01(puffsPerMin * dtMin);
      const puffNow = Math.random() < prob;

      const out = stepModel(dtMin, nicotine, poolDA, poolGABA, puffNow, params);

      setNicotine(out.nicotine);
      setPoolDA(out.poolDA);
      setPoolGABA(out.poolGABA);
      setAlpha7AchOn(out.alpha7AchOn);
      setAlpha7GluOn(out.alpha7GluOn);
      setAchDrive(out.achDrive);
      setGluDrive(out.gluDrive);
      setGaba(out.gaba);
      setDa(out.da);
      setDirect(out.direct);
      setIndirect(out.indirect);
      setSimMin((m) => m + dtMin);
      setTrace((prev) => {
        const t = simMin + dtMin;
        const desAll = clamp01(
          0.5 * out.poolDA.desens + 0.5 * out.poolGABA.desens,
        );
        const next = [
          ...prev,
          {
            t,
            da: out.da,
            gaba: out.gaba,
            nic: out.nicotine,
            desAll,
            puff: puffNow, // 👈 AQUÍ
          },
        ];
        const tMax = next.at(-1)?.t ?? 0;
        return next.filter((p) => p.t >= tMax - 60);
      });

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastT.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning, nicotine, poolDA, poolGABA, puffsPerMin, params]);

  useEffect(() => {
    // DA
    if (stateDA === "desensibilizado" && desensStartDA == null) {
      setDesensStartDA(simMin);
    }
    if (stateDA !== "desensibilizado" && desensStartDA != null) {
      setDesensStartDA(null);
    }

    // GABA
    if (stateG === "desensibilizado" && desensStartG == null) {
      setDesensStartG(simMin);
    }
    if (stateG !== "desensibilizado" && desensStartG != null) {
      setDesensStartG(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateDA, stateG, simMin, desensStartDA, desensStartG]);

  // chart
  const chartW = 760;
  const chartH = 150;
  const pad = 10;

  const LEGEND_H = 26; // espacio arriba para la mini-leyenda
  const BAND_H = 10; // alto de cada banda
  const BAND_GAP = 4; // separación entre bandas
  const BANDS_TOTAL = BAND_H * 2 + BAND_GAP; // nicotina + desens
  const plotTop = pad + LEGEND_H;
  const plotBottom = chartH - pad - BANDS_TOTAL - 6; // aire
  const plotH = Math.max(10, plotBottom - plotTop);

  const yDomain = useMemo(() => {
    if (trace.length < 2) return { min: 0, max: 1 };

    const values = trace.flatMap((p) => [p.da, p.gaba]);
    let min = Math.min(...values);
    let max = Math.max(...values);

    // Evita colapsar el rango (si DA/GABA casi no varían)
    const minRange = 0.15;
    if (max - min < minRange) {
      const mid = (min + max) / 2;
      min = mid - minRange / 2;
      max = mid + minRange / 2;
    }

    // margen visual
    const padding = 0.1 * (max - min);

    return {
      min: Math.max(0, min - padding),
      max: Math.min(1, max + padding),
    };
  }, [trace]);

  const pts = useMemo(() => {
    if (trace.length < 2)
      return {
        da: "",
        gaba: "",
        band: [] as { x: number; w: number; vNic: number; vDes: number }[],
      };

    const n = trace.length;
    const x = (i: number) => pad + (i / (n - 1)) * (chartW - pad * 2);

    const y = (v: number) => {
      const { min, max } = yDomain;
      const norm = (v - min) / (max - min || 1);
      return plotTop + (1 - clamp01(norm)) * plotH;
    };

    // Bandas: 60 celdas (≈ 1/min)
    const bins = 60;
    const band = Array.from({ length: bins }).map((_, bi) => {
      const idx = Math.round((bi / (bins - 1)) * (n - 1));
      const vNic = clamp01(trace[idx].nic);
      const vDes = clamp01(trace[idx].desAll); // asegúrate de tener desAll en trace
      const x0 = pad + (bi / bins) * (chartW - pad * 2);
      const w = (chartW - pad * 2) / bins;
      return { x: x0, w, vNic, vDes };
    });

    return {
      da: trace.map((p, i) => `${x(i)},${y(p.da)}`).join(" "),
      gaba: trace.map((p, i) => `${x(i)},${y(p.gaba)}`).join(" "),
      band,
    };
  }, [trace, yDomain, chartW, chartH, pad, plotTop, plotH]);

  // SVG helpers
  const inhStroke = "#0f172a";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="max-w-6xl mx-auto p-6">
        <header className="flex flex-col gap-2 mb-5">
          <div className="flex items-center justify-between gap-3">
            <h1 className="text-2xl font-semibold text-600">
              Nicotina — circuito de recompensa
            </h1>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <Pill>Nicotina: {Math.round(nicotine * 100)}%</Pill>
              <Pill>α7 ACh: {alpha7AchOn ? "ON" : "OFF"}</Pill>
              <Pill>α7 Glu: {alpha7GluOn ? "ON" : "OFF"}</Pill>
              <Pill>α4β2 (DA): {stateDA}</Pill>
              <Pill>α4β2 (GABA): {stateG}</Pill>
              <Pill>Ventana desens: {params.desensWindowMin} min</Pill>
              <Pill>t ≈ {Math.round(simMin)} min</Pill>
            </div>
          </div>
          <p className="text-sm text-slate-600">
            Modelo conceptual para docencia: vía <b>directa</b> (α4β2 en neurona
            DA) y vía <b>indirecta</b> (α4β2 en GABA → desinhibición DA). La
            recuperación usa una
            <b> ventana típica</b> de desensibilización (p.ej., 45 min).
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
          {/* Circuit */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-medium text-slate-700">
                Circuito (esquema)
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 text-sm"
                  onClick={() => setIsRunning((v) => !v)}
                >
                  {isRunning ? "Pausar" : "Reanudar"}
                </button>
                <button
                  className="px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 text-sm"
                  onClick={reset}
                >
                  Reset
                </button>
              </div>
            </div>

            <svg
              viewBox="0 0 980 560"
              className="w-full h-auto rounded-xl bg-slate-50 border border-slate-200"
            >
              <defs>
                <marker
                  id="arrow"
                  markerWidth="10"
                  markerHeight="10"
                  refX="7"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L8,3 L0,6 Z" fill="#334155" />
                </marker>
                <marker
                  id="arrowGreen"
                  markerWidth="10"
                  markerHeight="10"
                  refX="7"
                  refY="3"
                  orient="auto"
                >
                  <path d="M0,0 L8,3 L0,6 Z" fill="#16a34a" />
                </marker>
                <marker
                  id="bar"
                  markerWidth="10"
                  markerHeight="10"
                  refX="7"
                  refY="3"
                  orient="auto"
                >
                  <rect x="0" y="0" width="3" height="6" fill={inhStroke} />
                </marker>
              </defs>
              <style>{`
                @keyframes flow {
                    from { stroke-dashoffset: 0; }
                    to { stroke-dashoffset: -40; }
                }
                @keyframes pulse {
                    0% {transform: scale(1); opacity: 0.9;}}
                    50% {transform: scale(1.03); opacity: 1;}
                    100% {transform: scale(1); opacity: 0.9;}
                }
`}</style>

              {/* Legend */}
              <g>
                <rect
                  x="18"
                  y="18"
                  width="330"
                  height="92"
                  rx="14"
                  fill="#ffffff"
                  stroke="#e2e8f0"
                />
                <text
                  x="34"
                  y="44"
                  fontSize="12"
                  fill="#334155"
                  fontWeight="700"
                >
                  Leyenda
                </text>
                <text x="34" y="64" fontSize="12" fill="#334155">
                  Flecha verde = excitación/facilitación
                </text>
                <text x="34" y="84" fontSize="12" fill="#334155">
                  Línea con “barra” = inhibición GABA
                </text>
                <text x="34" y="104" fontSize="12" fill="#334155">
                  Iconos α7/α4β2 cambian por estado (basal/activ./desens.)
                </text>
              </g>
              {/* Left module: ACh, Glu (bajado para no tapar la leyenda*/}
              <g transform="translate(0,26)">
                {/* ACh neuron */}
                <g>
                  {/* Halo animado ACh (más grande que el soma) */}
                  <circle
                    cx="190"
                    cy="170"
                    r={62}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth={8}
                    opacity={0.15 + 0.55 * achDrive}
                    style={{ animation: "pulse 1.1s ease-in-out infinite" }}
                  />

                  {/* Soma */}
                  <circle
                    cx="190"
                    cy="170"
                    r="48"
                    fill="#fef08a"
                    stroke="#334155"
                    strokeWidth="2"
                  />

                  {/* Texto (centrado respecto al nuevo cy=170) */}
                  <text
                    x="190"
                    y="166"
                    textAnchor="middle"
                    fontSize="16"
                    fill="#0f172a"
                    fontWeight="800"
                  >
                    ACh
                  </text>
                  <text
                    x="190"
                    y="190"
                    textAnchor="middle"
                    fontSize="11"
                    fill="#334155"
                  >
                    (colinérgica)
                  </text>

                  {/* Receptor α7 (bajado +20) */}
                  <rect
                    x="260"
                    y="152"
                    width="36"
                    height="36"
                    rx="10"
                    fill={alpha7AchOn ? "#16a34a" : "#94a3b8"}
                    stroke="#334155"
                    strokeWidth="2"
                  />
                  <text
                    x="278"
                    y="176"
                    textAnchor="middle"
                    fontSize="12"
                    fill="#0f172a"
                    fontWeight="800"
                  >
                    α7
                  </text>
                  <text
                    x="278"
                    y="196"
                    textAnchor="middle"
                    fontSize="10"
                    fill="#334155"
                  >
                    pre
                  </text>
                </g>

                {/* Glu neuron */}
                <g>
                  {/* Halo animado Glu */}
                  <circle
                    cx="190"
                    cy="300"
                    r={62}
                    fill="none"
                    stroke="#22c55e"
                    strokeWidth={8}
                    opacity={0.15 + 0.55 * gluDrive}
                    style={{ animation: "pulse 1.1s ease-in-out infinite" }}
                  />

                  <circle
                    cx="190"
                    cy="300"
                    r="48"
                    fill="#bbf7d0"
                    stroke="#334155"
                    strokeWidth="2"
                  />
                  <text
                    x="190"
                    y="296"
                    textAnchor="middle"
                    fontSize="16"
                    fill="#0f172a"
                    fontWeight="800"
                  >
                    Glu
                  </text>
                  <text
                    x="190"
                    y="320"
                    textAnchor="middle"
                    fontSize="11"
                    fill="#334155"
                  >
                    (glutamatérgica)
                  </text>

                  <rect
                    x="260"
                    y="282"
                    width="36"
                    height="36"
                    rx="10"
                    fill={alpha7GluOn ? "#16a34a" : "#94a3b8"}
                    stroke="#334155"
                    strokeWidth="2"
                  />
                  <text
                    x="278"
                    y="306"
                    textAnchor="middle"
                    fontSize="12"
                    fill="#0f172a"
                    fontWeight="800"
                  >
                    α7
                  </text>
                  <text
                    x="278"
                    y="326"
                    textAnchor="middle"
                    fontSize="10"
                    fill="#334155"
                  >
                    pre
                  </text>
                </g>
              </g>

              {/* GABA neuron */}
              <g>
                <circle
                  cx="790"
                  cy="190"
                  r="52"
                  fill="#bfdbfe"
                  stroke="#334155"
                  strokeWidth="2"
                />
                <text
                  x="790"
                  y="186"
                  textAnchor="middle"
                  fontSize="16"
                  fill="#0f172a"
                  fontWeight="800"
                >
                  GABA
                </text>
                <text
                  x="790"
                  y="210"
                  textAnchor="middle"
                  fontSize="11"
                  fill="#334155"
                >
                  (inhibitoria)
                </text>

                <rect
                  x="845"
                  y="165"
                  width="48"
                  height="48"
                  rx="12"
                  fill={receptorColor(stateG)}
                  stroke="#334155"
                  strokeWidth="2"
                />
                <RecoveryClock
                  cx={869}
                  cy={189}
                  r={30}
                  startMin={desensStartG}
                  nowMin={simMin}
                  windowMin={params.desensWindowMin}
                  color="#1d4ed8"
                  track="#dbeafe"
                  labelDy={-42}
                />
                <text
                  x="869"
                  y="194"
                  textAnchor="middle"
                  fontSize="12"
                  fill="#0f172a"
                  fontWeight="900"
                >
                  α4β2
                </text>
                <text
                  x="869"
                  y="216"
                  textAnchor="middle"
                  fontSize="10"
                  fill="#334155"
                >
                  (GABA)
                </text>
              </g>

              {/* DA neuron */}
              <g>
                {/* Halo animado DA */}
                <circle
                  cx="520"
                  cy="350"
                  r={82}
                  fill="none"
                  stroke="#ef4444"
                  strokeWidth={10}
                  opacity={0.1 + 0.65 * da}
                  style={{ animation: "pulse 0.9s ease-in-out infinite" }}
                />

                <circle
                  cx="520"
                  cy="350"
                  r="62"
                  fill="#fecaca"
                  stroke="#334155"
                  strokeWidth="2"
                />
                <text
                  x="520"
                  y="346"
                  textAnchor="middle"
                  fontSize="16"
                  fill="#0f172a"
                  fontWeight="900"
                >
                  DA
                </text>
                <text
                  x="520"
                  y="368"
                  textAnchor="middle"
                  fontSize="11"
                  fill="#334155"
                >
                  (AVT/VTA)
                </text>

                <rect
                  x="595"
                  y="320"
                  width="54"
                  height="54"
                  rx="14"
                  fill={receptorColor(stateDA)}
                  stroke="#334155"
                  strokeWidth="2"
                />
                <RecoveryClock
                  cx={622}
                  cy={347}
                  r={34}
                  startMin={desensStartDA}
                  nowMin={simMin}
                  windowMin={params.desensWindowMin}
                  color="#b91c1c"
                  track="#fecaca"
                  labelDy={-44}
                />

                <text
                  x="622"
                  y="352"
                  textAnchor="middle"
                  fontSize="12"
                  fill="#0f172a"
                  fontWeight="900"
                >
                  α4β2
                </text>
                <text
                  x="622"
                  y="374"
                  textAnchor="middle"
                  fontSize="10"
                  fill="#334155"
                >
                  (DA)
                </text>
              </g>

              {/* NAcc */}
              <g>
                <rect
                  x="455"
                  y="485"
                  width="130"
                  height="56"
                  rx="18"
                  fill="#e2e8f0"
                  stroke="#334155"
                  strokeWidth="2"
                />
                <text
                  x="520"
                  y="520"
                  textAnchor="middle"
                  fontSize="16"
                  fill="#0f172a"
                  fontWeight="900"
                >
                  NAcc
                </text>
              </g>

              {/* Excitatory arrows ACh/Glu to DA */}
              <path
                d="M300 176 C380 176 410 250 455 305"
                fill="none"
                stroke="#16a34a"
                strokeWidth="4"
                markerEnd="url(#arrowGreen)"
                opacity={0.35 + 0.65 * achDrive}
                strokeDasharray="10 10"
                style={{ animation: "flow 1.2s linear infinite" }}
              />
              <path
                d="M300 326 C385 326 420 330 458 335"
                fill="none"
                stroke="#16a34a"
                strokeWidth="4"
                markerEnd="url(#arrowGreen)"
                opacity={0.35 + 0.65 * gluDrive}
                strokeDasharray="10 10"
                style={{ animation: "flow 1.2s linear infinite" }}
              />

              {/* Inhibitory arrow GABA to DA */}
              <path
                d="M740 215 C680 250 645 285 595 325"
                fill="none"
                stroke={inhStroke}
                strokeWidth="4"
                markerEnd="url(#bar)"
                opacity={0.25 + 0.75 * gaba}
              />

              {/* DA to NAcc */}
              <path
                d="M520 412 L520 485"
                fill="none"
                stroke="#7f1d1d"
                strokeWidth="5"
                markerEnd="url(#arrow)"
                opacity={0.25 + 0.75 * da}
                strokeDasharray="10 10"
                style={{ animation: "flow 0.9s linear infinite" }}
              />

              {/* Labels: direct/indirect (más aire, texto no se corta) */}
              <g pointerEvents="none">
                {/* Directa */}
                <rect
                  x="230"
                  y="432"
                  width="220"
                  height="80"
                  rx="14"
                  fill="#ffffff"
                  fillOpacity={0.72}
                  stroke="#e2e8f0"
                />
                <text
                  x="235"
                  y="450"
                  fontSize="12"
                  fill="#334155"
                  fontWeight="800"
                >
                  Vía directa
                </text>
                <text x="237" y="480" fontSize="12" fill="#334155">
                  <tspan x="230" dy="0">
                    α4β2 en DA (post)
                  </tspan>
                  <tspan x="230" dy="14">
                    → ↑ DA hacia NAcc
                  </tspan>
                </text>
                <text
                  x="540"
                  y="456"
                  textAnchor="end"
                  fontSize="12"
                  fill="#0f172a"
                  fontWeight="800"
                  className="tabular-nums"
                >
                  {Math.round(direct * 100)}%
                </text>

                {/* Indirecta */}
                <rect
                  x="660"
                  y="430"
                  width="300"
                  height="80"
                  rx="14"
                  fill="#ffffff"
                  stroke="#e2e8f0"
                />
                <text
                  x="676"
                  y="454"
                  fontSize="12"
                  fill="#334155"
                  fontWeight="800"
                >
                  Vía indirecta
                </text>
                <text x="676" y="472" fontSize="12" fill="#334155">
                  <tspan x="676" dy="0">
                    α4β2 en GABA
                  </tspan>
                  <tspan x="676" dy="14">
                    → GABA ↓ (desens) → ↑ DA
                  </tspan>
                </text>
                <text
                  x="950"
                  y="454"
                  textAnchor="end"
                  fontSize="12"
                  fill="#0f172a"
                  fontWeight="800"
                  className="tabular-nums"
                >
                  {Math.round(indirect * 100)}%
                </text>
              </g>

              {/* Nicotina bar */}
              <g>
                <rect
                  x="690"
                  y="26"
                  width="260"
                  height="52"
                  rx="14"
                  fill="#ffffff"
                  stroke="#e2e8f0"
                />
                <text
                  x="706"
                  y="48"
                  fontSize="12"
                  fill="#334155"
                  fontWeight="700"
                >
                  Nicotina (proxy)
                </text>
                <rect
                  x="706"
                  y="58"
                  width="220"
                  height="12"
                  rx="6"
                  fill="#e2e8f0"
                />
                <rect
                  x="706"
                  y="58"
                  width={220 * clamp01(nicotine)}
                  height="12"
                  rx="6"
                  fill="#334155"
                />
                <text
                  x="940"
                  y="68"
                  textAnchor="end"
                  fontSize="12"
                  fill="#334155"
                  className="tabular-nums"
                >
                  {Math.round(clamp01(nicotine) * 100)}%
                </text>
              </g>
            </svg>
          </div>

          {/* Controls */}
          <aside className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
            <div className="text-sm font-medium text-slate-700 mb-3">
              Modo clase
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => applyPreset("puff")}
                className={`py-2 rounded-xl border text-xs ${preset === "puff" ? "bg-slate-900 text-white border-slate-900" : "bg-slate-50 border-slate-200"}`}
              >
                Puff único
              </button>
              <button
                onClick={() => applyPreset("repetido")}
                className={`py-2 rounded-xl border text-xs ${preset === "repetido" ? "bg-slate-900 text-white border-slate-900" : "bg-slate-50 border-slate-200"}`}
              >
                Puffs repetidos
              </button>
              <button
                onClick={() => applyPreset("abstinencia")}
                className={`py-2 rounded-xl border text-xs ${preset === "abstinencia" ? "bg-slate-900 text-white border-slate-900" : "bg-slate-50 border-slate-200"}`}
              >
                Abstinencia
              </button>
            </div>

            <button
              onClick={doPuff}
              className="w-full mt-4 py-3 rounded-2xl bg-slate-900 text-white font-medium"
            >
              Puff (+ nicotina)
            </button>

            {/* NEW: desens window */}
            <div className="mt-4">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-700">
                  Ventana desensibilización
                </label>
                <span className="text-sm text-slate-600 tabular-nums">
                  {params.desensWindowMin} min
                </span>
              </div>
              <input
                className="w-full mt-2"
                type="range"
                min={10}
                max={90}
                step={1}
                value={params.desensWindowMin}
                onChange={(e) =>
                  setParams((p) => ({
                    ...p,
                    desensWindowMin: parseInt(e.target.value, 10),
                  }))
                }
              />
              <p className="text-xs text-slate-500 mt-1">
                Por defecto 45 min (como referencia). Menor = recuperación más
                rápida.
              </p>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-slate-700">
                  Frecuencia (puffs/min)
                </label>
                <span className="text-sm text-slate-600 tabular-nums">
                  {puffsPerMin.toFixed(2)}
                </span>
              </div>
              <input
                className="w-full mt-2"
                type="range"
                min={0}
                max={0.5}
                step={0.01}
                value={puffsPerMin}
                onChange={(e) => setPuffsPerMin(parseFloat(e.target.value))}
              />
              <p className="text-xs text-slate-500 mt-1">
                0.10 ≈ 1 puff / 10 min (aprox., didáctico)
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 mt-4">
              <button
                onClick={advance60}
                className="py-2 rounded-xl border border-slate-200 bg-slate-50 text-sm"
              >
                +60 min
              </button>
              <button
                onClick={() => setIsRunning((v) => !v)}
                className="py-2 rounded-xl border border-slate-200 bg-slate-50 text-sm"
              >
                {isRunning ? "Pausar" : "Reanudar"}
              </button>
            </div>

            <div className="mt-4 p-3 rounded-2xl bg-slate-50 border border-slate-200">
              <div className="text-xs font-semibold text-slate-700 mb-2">
                Indicadores (proxies)
              </div>
              <div className="space-y-2">
                <Bar label="Dopamina (DA)" value={da} />
                <Bar label="GABA" value={gaba} />
                <Bar label="α4β2 desens (DA)" value={poolDA.desens} />
                <Bar label="α4β2 desens (GABA)" value={poolGABA.desens} />
                <Bar label="ACh drive (α7)" value={achDrive} />
                <Bar label="Glu drive (α7)" value={gluDrive} />
              </div>
              <div className="mt-3 text-xs text-slate-600">
                <div className="font-semibold text-slate-700">
                  Lectura rápida
                </div>
                <ul className="list-disc ml-4 mt-1 space-y-1">
                  <li>
                    <b>Directa</b> sube si α4β2 (DA) está activado.
                  </li>
                  <li>
                    <b>Indirecta</b> sube cuando baja GABA (desensibilización en
                    GABA).
                  </li>
                  <li>
                    La <b>ventana</b> controla cuánto tarda en volver a basal.
                  </li>
                </ul>
              </div>
            </div>

            <div className="mt-4 text-xs text-slate-600 leading-relaxed">
              <div className="font-semibold text-slate-700 mb-1">Nota</div>
              Este parámetro está pensado para enseñar el ciclo descrito en el
              tema (≈45 min).
            </div>
          </aside>
        </div>
        {/* Timeline */}
        <div className="mt-4 bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-slate-700">Timeline</div>
            <div className="text-xs text-slate-500">
              DA / GABA / Nicotina / Desens (DA & GABA)
            </div>
          </div>

          <svg
            width="100%"
            viewBox={`0 0 ${chartW} ${chartH}`}
            className="w-full h-auto rounded-xl bg-slate-50 border border-slate-200"
          >
            {/* 1) Grid suave */}
            {Array.from({ length: 5 }).map((_, i) => (
              <line
                key={`grid-${i}`}
                x1={pad}
                x2={chartW - pad}
                y1={pad + (i / 4) * (chartH - pad * 2)}
                y2={pad + (i / 4) * (chartH - pad * 2)}
                stroke="#e2e8f0"
              />
            ))}

            {/* 2) Bandas (abajo): Nicotina y Desens (detrás de todo) */}
            {/* Nicotina band (gris) */}
            {pts.band?.map((b, i) => (
              <rect
                key={`nic-${i}`}
                x={b.x}
                y={chartH - pad - 22}
                width={b.w + 1}
                height={10}
                fill="#94a3b8"
                opacity={0.1 + 0.7 * b.vNic}
                rx={2}
              />
            ))}

            {/* Desens band (violeta total) */}
            {pts.band?.map((b, i) => (
              <rect
                key={`des-${i}`}
                x={b.x}
                y={chartH - pad - 10}
                width={b.w + 1}
                height={10}
                fill="#7c3aed"
                opacity={0.1 + 0.75 * b.vDes}
                rx={2}
              />
            ))}

            {/* 3) Líneas (encima de bandas) */}
            <polyline
              points={pts.gaba}
              fill="none"
              stroke="#ee0f0f"
              strokeWidth={2.2}
              opacity={0.85}
            />
            <polyline
              points={pts.da}
              fill="none"
              stroke="#111827"
              strokeWidth={3.2}
              opacity={0.95}
            />

            {/* 4) Puff ticks (encima de líneas) */}
            {(() => {
              const tMax = trace.at(-1)?.t ?? 0;
              const tMin = tMax - 60;
              const span = 60;

              const xFromT = (t: number) =>
                pad + ((t - tMin) / span) * (chartW - pad * 2);

              return trace
                .filter((p) => p.puff && p.t >= tMin && p.t <= tMax)
                .map((p, i) => (
                  <line
                    key={`puff-${i}-${p.t}`}
                    x1={xFromT(p.t)}
                    x2={xFromT(p.t)}
                    // 👇 solo dentro del “plot”, no hasta abajo (evita tapar bandas/labels)
                    y1={plotTop}
                    y2={plotTop + plotH}
                    stroke="#f97316"
                    strokeWidth={2}
                    opacity={0.55}
                  />
                ));
            })()}

            {/* 5) Leyenda mini (arriba) */}
            <g>
              <line
                x1={pad + 10}
                y1={pad + 14}
                x2={pad + 44}
                y2={pad + 14}
                stroke="#111827"
                strokeWidth={3.2}
              />
              <text x={pad + 52} y={pad + 18} fontSize={12} fill="#111827">
                DA
              </text>

              <line
                x1={pad + 110}
                y1={pad + 14}
                x2={pad + 144}
                y2={pad + 14}
                stroke="#ee0f0f"
                strokeWidth={2.2}
              />
              <text x={pad + 152} y={pad + 18} fontSize={12} fill="#55334b">
                GABA
              </text>

              <rect
                x={pad + 220}
                y={pad + 8}
                width={16}
                height={8}
                fill="#94a3b8"
                opacity={0.5}
                rx={2}
              />
              <text x={pad + 242} y={pad + 18} fontSize={12} fill="#334155">
                Nicotina
              </text>

              <rect
                x={pad + 330}
                y={pad + 8}
                width={16}
                height={8}
                fill="#7c3aed"
                opacity={0.6}
                rx={2}
              />
              <text x={pad + 352} y={pad + 18} fontSize={12} fill="#334155">
                Desens (total)
              </text>
            </g>

            {/* 6) Etiquetas de tiempo */}
            <text x={pad} y={chartH - 4} fontSize={11} fill="#64748b">
              -60 min
            </text>
            <text
              x={chartW - pad}
              y={chartH - 4}
              fontSize={11}
              fill="#64748b"
              textAnchor="end"
            >
              ahora
            </text>
          </svg>
        </div>
        {/* End of Timeline */}
      </div>
      {/* End of Main Content */}
    </div>
  );
}
