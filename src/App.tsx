import React, { useEffect, useRef, useState, useCallback } from 'react';
import './App.css';

interface Vec2 {
  x: number;
  y: number;
}

interface BirdPin {
  id: number;
  isParent: boolean; // true: 親鳥（ニワトリ）, false: 黄色いヒヨコ
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  fallen: boolean;
  tilt: number;
  vTilt: number;
  hitFlash: number;
  wingPhase: number;
  // 全倒し飛び立ち演出用
  flyVx: number;
  flyVy: number;
  flyScale: number;
}

interface EggBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  spin: number;
  angle: number;
  rolling: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
  isFeather?: boolean;
}

const LANE_WIDTH = 360;
const LANE_HEIGHT = 620;
const BALL_START_Y = 535;
const CHICK_RADIUS = 13;
const PARENT_RADIUS = 17;
const BALL_RADIUS = 20;
const MAX_FRAMES = 5;

// 10羽の三角形配置（親鳥が混ざる特別ルール）
function createInitialPins(currentFrame: number): BirdPin[] {
  const pins: BirdPin[] = [];
  const startX = LANE_WIDTH / 2;
  const frontY = 155;
  const rowGapY = 30;
  const colGapX = 34;

  const parentCount = currentFrame >= 3 ? 2 : 1;
  const allIds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const candidatePool = [9, 8, 5, 6, 10, 7, 2, 3];
  const parentIds = new Set<number>();

  while (parentIds.size < parentCount) {
    const pick =
      candidatePool[Math.floor(Math.random() * candidatePool.length)] ??
      allIds[Math.floor(Math.random() * allIds.length)];
    parentIds.add(pick);
  }

  let id = 1;
  for (let row = 0; row < 4; row++) {
    const count = row + 1;
    const y = frontY - row * rowGapY;
    const rowStartX = startX - ((count - 1) * colGapX) / 2;

    for (let col = 0; col < count; col++) {
      const isParent = parentIds.has(id);
      pins.push({
        id: id++,
        isParent,
        x: rowStartX + col * colGapX,
        y,
        vx: 0,
        vy: 0,
        radius: isParent ? PARENT_RADIUS : CHICK_RADIUS,
        fallen: false,
        tilt: 0,
        vTilt: 0,
        hitFlash: 0,
        wingPhase: Math.random() * Math.PI * 2,
        flyVx: 0,
        flyVy: 0,
        flyScale: 1,
      });
    }
  }
  return pins;
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [score, setScore] = useState<number>(0);
  const [frame, setFrame] = useState<number>(1);
  const [throwInFrame, setThrowInFrame] = useState<number>(1);
  const [message, setMessage] = useState<string>(
    '卵をドラッグして狙い＆パワーを決めよう！'
  );
  const [isGameOver, setIsGameOver] = useState<boolean>(false);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);

  const stateRef = useRef({
    ball: {
      x: LANE_WIDTH / 2,
      y: BALL_START_Y,
      vx: 0,
      vy: 0,
      radius: BALL_RADIUS,
      spin: 0,
      angle: 0,
      rolling: false,
    } as EggBall,
    pins: createInitialPins(1),
    particles: [] as Particle[],
    isDragging: false,
    dragStart: { x: 0, y: 0 } as Vec2,
    dragCurrent: { x: 0, y: 0 } as Vec2,
    settleTimer: 0,
    flyingTimer: 0,
    pendingBonus: 0,
    pendingLabel: '',
    phase: 'aiming' as 'aiming' | 'rolling' | 'flying' | 'gameover',
    frame: 1,
    throwInFrame: 1,
    totalScore: 0,
    firstThrowDownCount: 0,
    awardedParentIds: new Set<number>(),
  });

  const playTone = useCallback(
    (
      freq: number,
      duration: number,
      type: OscillatorType = 'triangle',
      volume = 0.08,
      endFreqMultiplier = 1.25
    ) => {
      if (!soundEnabled) return;
      try {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(
          Math.max(60, freq * endFreqMultiplier),
          ctx.currentTime + duration * 0.8
        );
        gain.gain.setValueAtTime(volume, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(
          0.001,
          ctx.currentTime + duration
        );
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + duration);
        setTimeout(() => ctx.close(), duration * 1000 + 50);
      } catch {
        // オーディオ制限時は無視
      }
    },
    [soundEnabled]
  );

  const spawnParticles = useCallback(
    (x: number, y: number, color: string, count = 8, isFeather = false) => {
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
        const speed = 1.2 + Math.random() * 3.0;
        stateRef.current.particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0,
          maxLife: 24 + Math.floor(Math.random() * 14),
          color,
          size: isFeather ? 4 + Math.random() * 2.5 : 2.5 + Math.random() * 2.5,
          isFeather,
        });
      }
    },
    []
  );

  const resetBallPosition = useCallback((x = LANE_WIDTH / 2) => {
    stateRef.current.ball = {
      x,
      y: BALL_START_Y,
      vx: 0,
      vy: 0,
      radius: BALL_RADIUS,
      spin: 0,
      angle: 0,
      rolling: false,
    };
    stateRef.current.settleTimer = 0;
  }, []);

  const resetFullGame = useCallback(() => {
    const s = stateRef.current;
    s.pins = createInitialPins(1);
    s.particles = [];
    s.frame = 1;
    s.throwInFrame = 1;
    s.totalScore = 0;
    s.firstThrowDownCount = 0;
    s.awardedParentIds = new Set<number>();
    s.flyingTimer = 0;
    s.pendingBonus = 0;
    s.pendingLabel = '';
    s.phase = 'aiming';
    s.isDragging = false;
    resetBallPosition();

    setScore(0);
    setFrame(1);
    setThrowInFrame(1);
    setIsGameOver(false);
    setMessage('卵をドラッグして狙い＆パワーを決めよう！');
    playTone(587.33, 0.14, 'sine', 0.08);
  }, [playTone, resetBallPosition]);

  const advanceAfterClear = useCallback(() => {
    const s = stateRef.current;
    s.totalScore += s.pendingBonus;
    setScore(s.totalScore);
    setMessage(s.pendingLabel);

    if (s.frame >= MAX_FRAMES) {
      s.phase = 'gameover';
      setIsGameOver(true);
      setMessage(`ゲーム終了！最終スコア: ${s.totalScore} pt`);
    } else {
      s.frame += 1;
      s.throwInFrame = 1;
      s.firstThrowDownCount = 0;
      s.awardedParentIds.clear();
      s.pins = createInitialPins(s.frame);
      resetBallPosition();
      s.phase = 'aiming';
      setFrame(s.frame);
      setThrowInFrame(1);
    }
  }, [resetBallPosition]);

  const startAllFlyAway = useCallback(
    (bonusPoints: number, labelText: string) => {
      const s = stateRef.current;
      s.phase = 'flying';
      s.flyingTimer = 0;
      s.pendingBonus = bonusPoints;
      s.pendingLabel = labelText;

      for (const pin of s.pins) {
        pin.fallen = true;
        pin.tilt = 0;
        pin.vTilt = 0;
        const spreadX =
          (pin.x - LANE_WIDTH / 2) * 0.025 + (Math.random() - 0.5) * 1.4;
        pin.flyVx = spreadX;
        pin.flyVy = -(4.8 + Math.random() * 2.2);
        pin.flyScale = pin.isParent ? 1.08 : 0.95;
        spawnParticles(
          pin.x,
          pin.y,
          pin.isParent ? '#f8fafc' : '#fde047',
          6,
          true
        );
      }

      setMessage(`${labelText} みんな空へ飛び立った〜！`);
      playTone(523.25, 0.35, 'triangle', 0.1, 1.85);
    },
    [playTone, spawnParticles]
  );

  const evaluateThrow = useCallback(() => {
    const s = stateRef.current;
    const downedPins = s.pins.filter((p) => p.fallen);
    const downedCount = downedPins.length;

    let parentBonus = 0;
    let newlyDownedParents = 0;
    for (const pin of downedPins) {
      if (pin.isParent && !s.awardedParentIds.has(pin.id)) {
        s.awardedParentIds.add(pin.id);
        parentBonus += 3;
        newlyDownedParents += 1;
      }
    }

    if (s.throwInFrame === 1) {
      const newlyDown = downedCount;
      s.firstThrowDownCount = downedCount;
      s.totalScore += newlyDown + parentBonus;
      setScore(s.totalScore);

      if (downedCount === 10) {
        const strikeBase = 20;
        const parentNote = parentBonus > 0 ? ` 親鳥+${parentBonus}pt` : '';
        startAllFlyAway(
          strikeBase,
          `STRIKE!! 10羽パーフェクト！ (+${strikeBase}pt${parentNote})`
        );
      } else {
        s.throwInFrame = 2;
        resetBallPosition();
        s.phase = 'aiming';
        setThrowInFrame(2);
        const parentNote =
          newlyDownedParents > 0 ? `（親鳥ボーナス +${parentBonus}pt！）` : '';
        setMessage(`残り ${10 - downedCount} 羽！${parentNote} 2投目で狙おう`);
      }
    } else {
      const newlyDown = Math.max(0, downedCount - s.firstThrowDownCount);
      s.totalScore += newlyDown + parentBonus;
      setScore(s.totalScore);

      if (downedCount === 10) {
        const spareBonus = 5;
        const parentNote = parentBonus > 0 ? ` 親鳥+${parentBonus}pt` : '';
        startAllFlyAway(
          spareBonus,
          `SPARE!! 残りを全部倒した！ (+${spareBonus}pt${parentNote})`
        );
      } else {
        const parentNote =
          newlyDownedParents > 0 ? `（親鳥ボーナス +${parentBonus}pt！）` : '';
        setMessage(`${newlyDown}羽ゲット！${parentNote}`);
        playTone(440, 0.15, 'sine', 0.07);

        if (s.frame >= MAX_FRAMES) {
          s.phase = 'gameover';
          setIsGameOver(true);
          setMessage(`ゲーム終了！最終スコア: ${s.totalScore} pt`);
        } else {
          s.frame += 1;
          s.throwInFrame = 1;
          s.firstThrowDownCount = 0;
          s.awardedParentIds.clear();
          s.pins = createInitialPins(s.frame);
          resetBallPosition();
          s.phase = 'aiming';
          setFrame(s.frame);
          setThrowInFrame(1);
        }
      }
    }
  }, [playTone, resetBallPosition, startAllFlyAway]);

  const getCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>): Vec2 => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scaleX = LANE_WIDTH / rect.width;
    const scaleY = LANE_HEIGHT / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = stateRef.current;
    if (s.phase !== 'aiming') return;

    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = getCanvasPoint(e);
    s.isDragging = true;
    s.dragStart = pt;
    s.dragCurrent = pt;

    if (Math.hypot(pt.x - s.ball.x, pt.y - s.ball.y) < 55) {
      const clampedX = Math.max(
        48 + BALL_RADIUS,
        Math.min(LANE_WIDTH - 48 - BALL_RADIUS, pt.x)
      );
      s.ball.x = clampedX;
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = stateRef.current;
    if (!s.isDragging || s.phase !== 'aiming') return;
    s.dragCurrent = getCanvasPoint(e);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const s = stateRef.current;
    if (!s.isDragging || s.phase !== 'aiming') return;

    s.isDragging = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }

    const dx = s.dragCurrent.x - s.dragStart.x;
    const dy = s.dragCurrent.y - s.dragStart.y;
    const pullDistance = Math.hypot(dx, dy);

    if (pullDistance < 14) {
      s.ball.vx = 0;
      s.ball.vy = -10.5;
      s.ball.spin = 0.05;
      s.ball.rolling = true;
      s.phase = 'rolling';
      playTone(260, 0.12, 'sine', 0.06);
      return;
    }

    let dirX = dx;
    let dirY = dy;
    if (dirY > -8) {
      dirX = -dx;
      dirY = -Math.abs(dy || 30);
    }

    const len = Math.hypot(dirX, dirY) || 1;
    const nx = dirX / len;
    const ny = dirY / len;

    const power = Math.min(18.5, Math.max(9.5, pullDistance * 0.11));
    s.ball.vx = nx * power * 0.85;
    s.ball.vy = Math.min(-8.5, ny * power);
    s.ball.spin = nx * 0.22;
    s.ball.rolling = true;
    s.phase = 'rolling';
    playTone(280, 0.14, 'triangle', 0.07);
  };

  useEffect(() => {
    let animId = 0;

    const updatePhysics = () => {
      const s = stateRef.current;
      const leftWall = 44;
      const rightWall = LANE_WIDTH - 44;

      s.particles = s.particles.filter((pt) => {
        pt.x += pt.vx;
        pt.y += pt.vy;
        pt.vx *= pt.isFeather ? 0.96 : 0.94;
        pt.vy =
          pt.vy * (pt.isFeather ? 0.96 : 0.94) + (pt.isFeather ? 0.04 : 0);
        pt.life += 1;
        return pt.life < pt.maxLife;
      });

      for (const pin of s.pins) {
        if (pin.hitFlash > 0) pin.hitFlash -= 1;
        const speed =
          s.phase === 'flying'
            ? 0.65
            : pin.fallen || Math.hypot(pin.vx, pin.vy) > 0.3
            ? 0.45
            : 0.08;
        pin.wingPhase += speed;
      }

      if (s.phase === 'flying') {
        s.flyingTimer += 1;
        for (const pin of s.pins) {
          pin.x += pin.flyVx + Math.sin(pin.wingPhase * 0.5) * 0.7;
          pin.y += pin.flyVy;
          pin.flyVy *= 0.992;
          pin.flyScale = Math.max(0.45, pin.flyScale - 0.006);

          if (s.flyingTimer % 6 === 0 && pin.y > -40) {
            spawnParticles(
              pin.x,
              pin.y,
              pin.isParent ? '#f1f5f9' : '#fde047',
              2,
              true
            );
          }
        }

        if (s.flyingTimer >= 72) {
          advanceAfterClear();
        }
        return;
      }

      if (s.phase === 'rolling') {
        const b = s.ball;

        if (b.y > -40) {
          b.x += b.vx;
          b.y += b.vy;
          b.vx += b.spin * 0.1;
          b.vy *= 0.994;
          b.angle += b.spin + Math.abs(b.vy) * 0.012;

          if (b.x - b.radius < leftWall || b.x + b.radius > rightWall) {
            b.vx *= 0.45;
            b.vy *= 0.96;
          }
        }

        // 卵と鳥ピン（ヒヨコ／親鳥）の衝突
        for (const pin of s.pins) {
          const dx = pin.x - b.x;
          const dy = pin.y - b.y;
          const dist = Math.hypot(dx, dy);
          const minDist = pin.radius + b.radius;

          if (dist > 0 && dist < minDist) {
            const nx = dx / dist;
            const ny = dy / dist;
            const overlap = minDist - dist;

            pin.x += nx * overlap * 0.85;
            pin.y += ny * overlap * 0.85;

            const ballSpeed = Math.hypot(b.vx, b.vy);
            const massFactor = pin.isParent ? 0.68 : 0.78;
            pin.vx +=
              nx * (ballSpeed * massFactor + 2.2) + (Math.random() - 0.5) * 1.4;
            pin.vy += ny * (ballSpeed * massFactor + 2.2) - 1.2;
            pin.fallen = true;
            pin.vTilt += (nx + (Math.random() - 0.5)) * 0.15;
            pin.hitFlash = 12;

            b.vx -= nx * (pin.isParent ? 1.6 : 1.1);
            b.vy -= ny * (pin.isParent ? 1.0 : 0.7);
            b.spin += nx * 0.08;

            spawnParticles(
              pin.x,
              pin.y,
              pin.isParent ? '#ffffff' : '#fde047',
              pin.isParent ? 8 : 6,
              true
            );
            spawnParticles(pin.x, pin.y, '#fef3c7', 4, false);
            playTone(
              pin.isParent
                ? 420 + Math.random() * 140
                : 760 + Math.random() * 280,
              0.1,
              pin.isParent ? 'triangle' : 'sine',
              0.06
            );
          }
        }

        // 鳥ピン同士のドミノ衝突
        for (let i = 0; i < s.pins.length; i++) {
          for (let j = i + 1; j < s.pins.length; j++) {
            const p1 = s.pins[i];
            const p2 = s.pins[j];
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const dist = Math.hypot(dx, dy);
            const minDist = p1.radius + p2.radius;

            if (dist > 0 && dist < minDist) {
              const nx = dx / dist;
              const ny = dy / dist;
              const overlap = (minDist - dist) * 0.5;

              p1.x -= nx * overlap;
              p1.y -= ny * overlap;
              p2.x += nx * overlap;
              p2.y += ny * overlap;

              const relVx = p2.vx - p1.vx;
              const relVy = p2.vy - p1.vy;
              const impulse = (relVx * nx + relVy * ny) * 0.75;

              if (impulse < 0) {
                const jImp = -impulse;
                p1.vx -= nx * jImp;
                p1.vy -= ny * jImp;
                p2.vx += nx * jImp;
                p2.vy += ny * jImp;

                if (Math.hypot(p1.vx, p1.vy) > 1.1) {
                  p1.fallen = true;
                  p1.vTilt -= nx * 0.11;
                }
                if (Math.hypot(p2.vx, p2.vy) > 1.1) {
                  p2.fallen = true;
                  p2.vTilt += nx * 0.11;
                }

                spawnParticles(
                  (p1.x + p2.x) / 2,
                  (p1.y + p2.y) / 2,
                  '#facc15',
                  3,
                  true
                );
                playTone(840 + Math.random() * 260, 0.07, 'sine', 0.04);
              }
            }
          }
        }

        for (const pin of s.pins) {
          pin.x += pin.vx;
          pin.y += pin.vy;
          pin.vx *= 0.93;
          pin.vy *= 0.93;

          if (pin.x - pin.radius < leftWall) {
            pin.x = leftWall + pin.radius;
            pin.vx = Math.abs(pin.vx) * 0.6;
          }
          if (pin.x + pin.radius > rightWall) {
            pin.x = rightWall - pin.radius;
            pin.vx = -Math.abs(pin.vx) * 0.6;
          }
          if (pin.y < 36) {
            pin.y = 36;
            pin.vy = Math.abs(pin.vy) * 0.5;
          }

          if (pin.fallen) {
            pin.tilt += pin.vTilt;
            pin.vTilt *= 0.88;
            const maxTilt = 1.25;
            if (pin.tilt > maxTilt) {
              pin.tilt = maxTilt;
              pin.vTilt = 0;
            } else if (pin.tilt < -maxTilt) {
              pin.tilt = -maxTilt;
              pin.vTilt = 0;
            }
          } else {
            pin.tilt *= 0.85;
          }
        }

        const ballStopped =
          b.y < -25 ||
          (Math.abs(b.vx) < 0.12 &&
            Math.abs(b.vy) < 0.12 &&
            b.y < BALL_START_Y - 30);
        const pinsMoving = s.pins.some((p) => Math.hypot(p.vx, p.vy) > 0.18);

        if (ballStopped && !pinsMoving) {
          s.settleTimer += 1;
          if (s.settleTimer > 32) {
            evaluateThrow();
          }
        } else {
          s.settleTimer = 0;
        }
      }
    };

    const drawBirdPin = (
      ctx: CanvasRenderingContext2D,
      pin: BirdPin,
      isFlyingPhase: boolean
    ) => {
      ctx.save();
      ctx.translate(pin.x, pin.y);

      const shadowOffsetY = isFlyingPhase ? 26 : 5;
      const shadowScale = isFlyingPhase ? 0.55 : 1;
      ctx.beginPath();
      ctx.ellipse(
        pin.fallen && !isFlyingPhase ? 6 : 2,
        shadowOffsetY,
        pin.radius * 0.9 * shadowScale,
        pin.radius * 0.6 * shadowScale,
        0,
        0,
        Math.PI * 2
      );
      ctx.fillStyle = isFlyingPhase
        ? 'rgba(0, 0, 0, 0.12)'
        : 'rgba(0, 0, 0, 0.22)';
      ctx.fill();

      ctx.rotate(pin.tilt);

      const scale = isFlyingPhase ? pin.flyScale : pin.fallen ? 0.88 : 1;
      ctx.scale(scale, scale);

      const flap = Math.sin(pin.wingPhase) * (isFlyingPhase ? 0.75 : 0.35);

      if (pin.isParent) {
        // --- 親鳥（ニワトリ）描画 ---
        ctx.fillStyle = '#f8fafc';
        ctx.strokeStyle = '#7f1d1d';
        ctx.lineWidth = 1.4;

        ctx.save();
        ctx.translate(-13, 2);
        ctx.rotate(-0.45 - flap);
        ctx.beginPath();
        ctx.ellipse(-4, 0, 7.5, 4.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.translate(13, 2);
        ctx.rotate(0.45 + flap);
        ctx.beginPath();
        ctx.ellipse(4, 0, 7.5, 4.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        ctx.beginPath();
        ctx.moveTo(-6, 13);
        ctx.lineTo(-10, 21);
        ctx.lineTo(-2, 19);
        ctx.lineTo(0, 22);
        ctx.lineTo(3, 19);
        ctx.lineTo(10, 21);
        ctx.lineTo(6, 13);
        ctx.closePath();
        ctx.fillStyle = '#e2e8f0';
        ctx.fill();
        ctx.stroke();

        const parentGrad = ctx.createRadialGradient(-4, -6, 2, 0, 0, 20);
        parentGrad.addColorStop(0, '#ffffff');
        parentGrad.addColorStop(0.7, '#f1f5f9');
        parentGrad.addColorStop(1, '#cbd5e1');
        ctx.beginPath();
        ctx.ellipse(0, 1, 15.5, 16.5, 0, 0, Math.PI * 2);
        ctx.fillStyle = parentGrad;
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = pin.hitFlash > 0 ? '#fde047' : '#7f1d1d';
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(-5, -15, 4.2, 0, Math.PI * 2);
        ctx.arc(0, -17, 4.8, 0, Math.PI * 2);
        ctx.arc(5, -15, 4.2, 0, Math.PI * 2);
        ctx.fillStyle = '#ef4444';
        ctx.fill();
        ctx.strokeStyle = '#7f1d1d';
        ctx.lineWidth = 1.2;
        ctx.stroke();

        ctx.beginPath();
        ctx.ellipse(0, 7.5, 3.2, 4.2, 0, 0, Math.PI * 2);
        ctx.fillStyle = '#dc2626';
        ctx.fill();

        ctx.strokeStyle = '#1c1917';
        ctx.fillStyle = '#1c1917';
        ctx.lineWidth = 1.7;
        if (pin.fallen && !isFlyingPhase) {
          ctx.beginPath();
          ctx.moveTo(-8.5, -5.5);
          ctx.lineTo(-4.5, -3);
          ctx.lineTo(-8.5, -0.5);
          ctx.moveTo(8.5, -5.5);
          ctx.lineTo(4.5, -3);
          ctx.lineTo(8.5, -0.5);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(-6, -3, 2.4, 0, Math.PI * 2);
          ctx.arc(6, -3, 2.4, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.beginPath();
        ctx.moveTo(-4, 0.5);
        ctx.lineTo(4, 0.5);
        ctx.lineTo(0, 5.5);
        ctx.closePath();
        ctx.fillStyle = '#f59e0b';
        ctx.fill();
        ctx.strokeStyle = '#92400e';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else {
        // --- 黄色いヒヨコ描画 ---
        ctx.fillStyle = pin.fallen && !isFlyingPhase ? '#eab308' : '#facc15';
        ctx.strokeStyle = '#854d0e';
        ctx.lineWidth = 1.3;

        ctx.save();
        ctx.translate(-11, 2);
        ctx.rotate(-0.35 - flap);
        ctx.beginPath();
        ctx.ellipse(-3, 0, 5.5, 3.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.translate(11, 2);
        ctx.rotate(0.35 + flap);
        ctx.beginPath();
        ctx.ellipse(3, 0, 5.5, 3.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        const bodyGrad = ctx.createRadialGradient(-3, -6, 2, 0, 0, 17);
        if (pin.fallen && !isFlyingPhase) {
          bodyGrad.addColorStop(0, '#fef08a');
          bodyGrad.addColorStop(0.65, '#eab308');
          bodyGrad.addColorStop(1, '#ca8a04');
        } else {
          bodyGrad.addColorStop(0, '#fef9c3');
          bodyGrad.addColorStop(0.55, '#fde047');
          bodyGrad.addColorStop(1, '#eab308');
        }

        ctx.beginPath();
        ctx.ellipse(0, 2, 12.5, 13.5, 0, 0, Math.PI * 2);
        ctx.fillStyle = bodyGrad;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = pin.hitFlash > 0 ? '#ffffff' : '#713f12';
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(-2, -11);
        ctx.quadraticCurveTo(-5, -18, -1, -17);
        ctx.quadraticCurveTo(1, -19, 3, -16);
        ctx.quadraticCurveTo(6, -17, 2, -11);
        ctx.fillStyle = '#fde047';
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = 'rgba(244, 114, 182, 0.55)';
        ctx.beginPath();
        ctx.ellipse(-7.5, 1, 3.2, 2.2, 0, 0, Math.PI * 2);
        ctx.ellipse(7.5, 1, 3.2, 2.2, 0, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = '#1c1917';
        ctx.fillStyle = '#1c1917';
        ctx.lineWidth = 1.6;
        if ((pin.fallen && !isFlyingPhase) || pin.hitFlash > 0) {
          ctx.beginPath();
          ctx.moveTo(-7, -4.5);
          ctx.lineTo(-3.5, -2.5);
          ctx.lineTo(-7, -0.5);
          ctx.moveTo(7, -4.5);
          ctx.lineTo(3.5, -2.5);
          ctx.lineTo(7, -0.5);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(-5, -2.5, 2.1, 0, Math.PI * 2);
          ctx.arc(5, -2.5, 2.1, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(-5.6, -3.2, 0.8, 0, Math.PI * 2);
          ctx.arc(4.4, -3.2, 0.8, 0, Math.PI * 2);
          ctx.fill();
        }

        ctx.beginPath();
        ctx.moveTo(-3.5, 0.5);
        ctx.lineTo(3.5, 0.5);
        ctx.lineTo(0, 5.5);
        ctx.closePath();
        ctx.fillStyle = '#f97316';
        ctx.fill();
        ctx.strokeStyle = '#9a3412';
        ctx.lineWidth = 1.1;
        ctx.stroke();
      }

      ctx.restore();
    };

    const drawEggBall = (ctx: CanvasRenderingContext2D, b: EggBall) => {
      if (b.y <= -30) return;

      ctx.save();
      ctx.translate(b.x, b.y);

      // 影
      ctx.beginPath();
      ctx.ellipse(3, 6, b.radius * 0.88, b.radius * 1.05, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.fill();

      // 回転反映
      ctx.rotate(b.angle);

      // 卵の輪郭（上が少し細く、下が丸い卵型）
      const eggGrad = ctx.createRadialGradient(
        -5,
        -7,
        3,
        0,
        2,
        b.radius * 1.25
      );
      eggGrad.addColorStop(0, '#ffffff');
      eggGrad.addColorStop(0.65, '#fef9c3');
      eggGrad.addColorStop(1, '#fde68a');

      ctx.beginPath();
      ctx.moveTo(0, -b.radius * 1.15);
      ctx.bezierCurveTo(
        b.radius * 0.95,
        -b.radius * 0.95,
        b.radius * 1.05,
        b.radius * 0.55,
        0,
        b.radius * 1.12
      );
      ctx.bezierCurveTo(
        -b.radius * 1.05,
        b.radius * 0.55,
        -b.radius * 0.95,
        -b.radius * 0.95,
        0,
        -b.radius * 1.15
      );
      ctx.closePath();

      ctx.fillStyle = eggGrad;
      ctx.fill();
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = '#b45309';
      ctx.stroke();

      // 卵の殻の模様（ジグザグのヒビ風アクセント）
      ctx.strokeStyle = 'rgba(217, 119, 6, 0.45)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(-8, 1);
      ctx.lineTo(-4, -3);
      ctx.lineTo(0, 2);
      ctx.lineTo(4, -3);
      ctx.lineTo(8, 1);
      ctx.stroke();

      // 艶ハイライト
      ctx.beginPath();
      ctx.ellipse(-4.5, -7, 2.5, 5, -0.35, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.fill();

      ctx.restore();
    };

    const drawScene = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const s = stateRef.current;
      ctx.clearRect(0, 0, LANE_WIDTH, LANE_HEIGHT);

      // レーン背景
      const laneGrad = ctx.createLinearGradient(0, 0, 0, LANE_HEIGHT);
      laneGrad.addColorStop(0, '#e3c088');
      laneGrad.addColorStop(0.5, '#f0d3a2');
      laneGrad.addColorStop(1, '#d8b174');
      ctx.fillStyle = laneGrad;
      ctx.fillRect(0, 0, LANE_WIDTH, LANE_HEIGHT);

      // 木目ライン
      ctx.strokeStyle = 'rgba(120, 75, 28, 0.16)';
      ctx.lineWidth = 1;
      for (let x = 56; x < LANE_WIDTH - 44; x += 18) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, LANE_HEIGHT);
        ctx.stroke();
      }

      // 狙い矢印マーカー
      ctx.fillStyle = 'rgba(202, 138, 4, 0.35)';
      for (let i = -2; i <= 2; i++) {
        const ax = LANE_WIDTH / 2 + i * 24;
        const ay = 340 - Math.abs(i) * 8;
        ctx.beginPath();
        ctx.moveTo(ax, ay - 9);
        ctx.lineTo(ax - 5, ay + 4);
        ctx.lineTo(ax + 5, ay + 4);
        ctx.closePath();
        ctx.fill();
      }

      // ファウルライン
      ctx.strokeStyle = '#eab308';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(44, 470);
      ctx.lineTo(LANE_WIDTH - 44, 470);
      ctx.stroke();

      // 左右ガター
      ctx.fillStyle = '#262932';
      ctx.fillRect(0, 0, 44, LANE_HEIGHT);
      ctx.fillRect(LANE_WIDTH - 44, 0, 44, LANE_HEIGHT);

      ctx.fillStyle = '#4b5563';
      ctx.fillRect(42, 0, 3, LANE_HEIGHT);
      ctx.fillRect(LANE_WIDTH - 45, 0, 3, LANE_HEIGHT);

      // ヒヨコ＆親鳥描画
      const isFlyingPhase = s.phase === 'flying';
      for (const pin of s.pins) {
        drawBirdPin(ctx, pin, isFlyingPhase);
      }

      // 狙いガイド線
      if (s.isDragging && s.phase === 'aiming') {
        const dx = s.dragCurrent.x - s.dragStart.x;
        const dy = s.dragCurrent.y - s.dragStart.y;
        let dirX = dx;
        let dirY = dy;
        if (dirY > -8) {
          dirX = -dx;
          dirY = -Math.abs(dy || 30);
        }
        const len = Math.hypot(dirX, dirY) || 1;
        const nx = dirX / len;
        const ny = dirY / len;
        const pull = Math.min(180, Math.hypot(dx, dy));

        ctx.save();
        ctx.setLineDash([7, 7]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#f59e0b';
        ctx.beginPath();
        ctx.moveTo(s.ball.x, s.ball.y);
        ctx.lineTo(
          s.ball.x + nx * (90 + pull * 0.7),
          s.ball.y + ny * (90 + pull * 0.7)
        );
        ctx.stroke();
        ctx.restore();
      }

      // 卵ボール描画
      drawEggBall(ctx, s.ball);

      // パーティクル描画
      for (const pt of s.particles) {
        const alpha = 1 - pt.life / pt.maxLife;
        ctx.globalAlpha = Math.max(0, alpha);
        ctx.fillStyle = pt.color;
        ctx.beginPath();
        if (pt.isFeather) {
          ctx.ellipse(
            pt.x,
            pt.y,
            pt.size,
            pt.size * 0.55,
            pt.life * 0.15,
            0,
            Math.PI * 2
          );
        } else {
          ctx.arc(pt.x, pt.y, pt.size, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const tick = () => {
      updatePhysics();
      drawScene();
      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [advanceAfterClear, evaluateThrow, playTone, spawnParticles]);

  return (
    <div className="game-wrapper">
      <header className="hud-header">
        <div className="brand-title">
          <span className="chick-badge">EGG & BIRDS</span>
          <h1>BOWLING</h1>
        </div>
        <div className="stats-row">
          <div className="stat-box">
            <span className="stat-label">FRAME</span>
            <span className="stat-value">
              {frame} / {MAX_FRAMES}
            </span>
          </div>
          <div className="stat-box">
            <span className="stat-label">BALL</span>
            <span className="stat-value">{throwInFrame}</span>
          </div>
          <div className="stat-box highlight">
            <span className="stat-label">SCORE</span>
            <span className="stat-value">{score}</span>
          </div>
        </div>
      </header>

      <div className="status-banner">{message}</div>

      <div className="rule-strip">
        <span>🥚 ボール：卵</span>
        <span>🐔 親鳥：+3ptボーナス</span>
      </div>

      <main className="lane-stage">
        <canvas
          ref={canvasRef}
          width={LANE_WIDTH}
          height={LANE_HEIGHT}
          className="bowling-canvas"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />

        {isGameOver && (
          <div className="overlay-card">
            <h2>FINISH!</h2>
            <p className="final-score">{score} PTS</p>
            <p className="sub-note">
              卵＆ヒヨコ・親鳥ボウリング（全{MAX_FRAMES}フレーム）
            </p>
            <button
              type="button"
              className="primary-btn"
              onClick={resetFullGame}
            >
              もう一度遊ぶ
            </button>
          </div>
        )}
      </main>

      <footer className="controls-bar">
        <button
          type="button"
          className="secondary-btn"
          onClick={() => setSoundEnabled((prev) => !prev)}
        >
          {soundEnabled ? '🔊 効果音: ON' : '🔇 効果音: OFF'}
        </button>
        <button type="button" className="secondary-btn" onClick={resetFullGame}>
          ↻ リセット
        </button>
      </footer>
    </div>
  );
}

export default App;
