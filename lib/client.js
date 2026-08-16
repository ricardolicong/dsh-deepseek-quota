// dsh-deepseek-quota — browser half.
//
// A floating card pinned to the bottom-right corner of the dsh web GUI
// (registered into the frame-wide `shell.overlay` slot — additive, above
// every column, click-through until the card opts back into pointer events).
// It polls the host route `/api/deepseek-balance` (see lib/index.js) every
// minute and shows the remaining DeepSeek API balance, today's consumption
// and the current conversation cost.
//
// UI (per user design): theme-following rounded card (`--dsw-*` tokens,
// compact 260px), pinned to the bottom-right of the viewport. A compact
// leather-wallet SVG sits on the bottom row, right of the update time; the
// wallet's protruding bill stack shows 当前余额 ÷ 满额参考 (the reference
// is the balance right after the last top-up, detected from
// topped_up_balance increases, persisted in localStorage). Seven SVG
// 100-yuan banknotes blow UP out of the wallet's mouth with random,
// curling wind-blown motion (rotation wobble + S-curve + fade, negative-
// delay staggering = continuous stream, no pauses) — they animate ONLY
// while the agent is busy (session running); on stop, notes already in
// flight finish their current run (drain) instead of freezing mid-air.
//
// Extra UX: drag anywhere on the card to float it, and use the minimize
// button to collapse it into a small draggable tile (click to expand).
// Position and minimized state persist in localStorage.
window.__ModuleLoader__.load({
	id: "dsh-deepseek-quota",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		const { useState, useEffect, useCallback, useRef } = react;
		const { jsx, jsxs, Fragment } = jsxRuntime;

		// ---- constants -------------------------------------------------
		const POLL_MS = 60 * 1000;
		const BALANCE_PATH = "/api/deepseek-balance";
		/** localStorage 键：持久化卡片位置与最小化状态。 */
		const UI_STORAGE_KEY = "dsh-deepseek-quota.ui";
		/** localStorage 键：充值参考快照（用于进度条满额计算）。 */
		const REF_STORAGE_KEY = "dsh-deepseek-quota.ref";
		/** 拖动判定阈值（px）：低于该位移视为点击而非拖动。 */
		const DRAG_THRESHOLD_PX = 4;
		/** 注入的 @keyframes <style> 元素 id。 */
		const FLY_KEYFRAMES_ID = "dsh-deepseek-quota-keys";

		// ---- small helpers ---------------------------------------------
		function currencySymbol(code) {
			switch (code) {
				case "CNY": return "¥";
				case "USD": return "$";
				case "EUR": return "€";
				case "JPY": return "¥";
				case "HKD": return "HK$";
				default: return code ? `${code} ` : "";
			}
		}

		function formatBalance(value, currency) {
			const symbol = currencySymbol(currency);
			return `${symbol}${String(value)}`;
		}

		function formatTime(date) {
			const hh = String(date.getHours()).padStart(2, "0");
			const mm = String(date.getMinutes()).padStart(2, "0");
			const ss = String(date.getSeconds()).padStart(2, "0");
			return `${hh}:${mm}:${ss}`;
		}

		// 读取上次的界面状态（位置 + 最小化），localStorage 持久化，解析失败则回退默认。
		function loadUiState() {
			try {
				const raw = localStorage.getItem(UI_STORAGE_KEY);
				if (!raw) return null;
				const parsed = JSON.parse(raw);
				if (parsed === null || typeof parsed !== "object") return null;
				const out = {};
				if (typeof parsed.x === "number" && Number.isFinite(parsed.x)) out.x = Math.round(parsed.x);
				if (typeof parsed.y === "number" && Number.isFinite(parsed.y)) out.y = Math.round(parsed.y);
				if (parsed.minimized === true) out.minimized = true;
				return Object.keys(out).length > 0 ? out : null;
			} catch {
				return null;
			}
		}

		// 读取充值参考快照：{ topup, total, reference }（充值余额、当时总额、满额参考）。
		function readRef() {
			try {
				const raw = localStorage.getItem(REF_STORAGE_KEY);
				if (!raw) return null;
				const parsed = JSON.parse(raw);
				if (
					parsed !== null && typeof parsed === "object" &&
					typeof parsed.topup === "number" && Number.isFinite(parsed.topup) &&
					typeof parsed.total === "number" && Number.isFinite(parsed.total) &&
					typeof parsed.reference === "number" && Number.isFinite(parsed.reference) && parsed.reference > 0
				) {
					return parsed;
				}
			} catch {}
			return null;
		}

		// 计算进度条满额参考：当前余额 ÷ 满额。满额 = 最近一次充值金额 + 充值前剩余余额。
		// 充值检测：充值余额比上次快照变大即视为刚充值。
		function computeReference(prev, topup, total) {
			if (prev === null) {
				// 首次见到余额：以当前总额为满额（进度条 100%），等待下一次充值校准。
				return total > 0 ? total : 1;
			}
			if (topup > prev.topup + 0.005) {
				// 检测到充值：满额 = 充值金额 + 充值前剩余的余额（上次快照的总额）。
				const rechargeAmount = topup - prev.topup;
				return Math.max(0.01, prev.total + rechargeAmount);
			}
			return prev.reference;
		}

		async function fetchBalance() {
			const res = await fetch(BALANCE_PATH, { cache: "no-store" });
			let body = null;
			try {
				body = await res.json();
			} catch {}
			if (!res.ok) {
				const message =
					body && typeof body.message === "string"
						? body.message
						: `请求失败（HTTP ${res.status}）`;
				const error = new Error(message);
				error.code = body && typeof body.error === "string" ? body.error : `http-${res.status}`;
				throw error;
			}
			// New host shape: { ok, balance, todayConsumed }. Older host:
			// the raw provider payload verbatim. Accept both.
			const payload = body && typeof body === "object" && body.balance ? body.balance : body;
			const todayConsumed =
				body && typeof body === "object" && typeof body.todayConsumed === "number"
					? body.todayConsumed
					: null;
			return { payload, todayConsumed };
		}

		// ---- inline styles ---------------------------------------------
		const card = {
			position: "absolute",
			right: 16,
			bottom: 16,
			zIndex: 30,
			pointerEvents: "auto",
			boxSizing: "border-box",
			width: 260,
			borderRadius: 14,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-overlay)",
			boxShadow: "0 4px 16px rgba(0, 0, 0, 0.16)",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 12,
			lineHeight: "18px",
			padding: "12px 14px 10px",
			userSelect: "none",
			cursor: "grab",
			touchAction: "none",
			overflow: "hidden"
		};

		const headerRow = {
			display: "flex",
			justifyContent: "space-between",
			alignItems: "center",
			marginBottom: 8,
			cursor: "grab",
			userSelect: "none",
			touchAction: "none"
		};

		const title = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			fontSize: 13,
			fontWeight: 600,
			whiteSpace: "nowrap"
		};

		const dot = {
			flex: "none",
			width: 8,
			height: 8,
			borderRadius: "50%",
			marginRight: 8
		};

		const actions = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			color: "var(--dsw-alias-label-secondary)"
		};

		const iconBtn = {
			flex: "none",
			display: "inline-flex",
			alignItems: "center",
			justifyContent: "center",
			width: 20,
			height: 20,
			border: 0,
			borderRadius: 6,
			padding: 0,
			background: "transparent",
			color: "var(--dsw-alias-label-secondary)",
			cursor: "pointer"
		};

		const balanceRow = {
			display: "flex",
			alignItems: "center",
			marginBottom: 6,
			minWidth: 0,
			overflow: "hidden"
		};

		const amount = {
			fontSize: 24,
			lineHeight: "30px",
			fontWeight: 600,
			marginRight: 10,
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap"
		};

		const tag = {
			background: "var(--dsw-alias-interactive-bg-hover)",
			fontSize: 11,
			lineHeight: "18px",
			padding: "0 8px",
			borderRadius: 12,
			fontWeight: 500,
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap",
			flex: "none"
		};

		// 内容区：左栏四行（余额/当前对话/今日已用/更新时间），右栏钱包占满四行高度。
		const contentRow = {
			display: "flex",
			alignItems: "flex-start",
			gap: 10
		};

		const contentCol = {
			display: "flex",
			flexDirection: "column",
			flex: 1,
			minWidth: 0
		};

		const statsRow = {
			display: "flex",
			flexDirection: "column",
			alignItems: "flex-start",
			gap: 2,
			marginBottom: 6,
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 10.5,
			lineHeight: "15px",
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap",
			overflow: "hidden"
		};

		// 钱包盒子：占满四行高度的右栏；钱包 SVG 底部对齐，纸币从钱包口飞出。
		const walletBox = {
			position: "relative",
			flex: "none",
			display: "flex",
			alignItems: "flex-end",
			justifyContent: "center",
			paddingBottom: 6,
			width: 56,
			height: 84
		};

		// 飞舞的纸币：从进度条右段出发，向右上方飘走。票面用 SVG 还原百元人民币。
		// 外层 div 负责定位/缩放，内层 div 跑飞行动画（外层的 transform 不会被动画覆盖）。
		const flyingNote = {
			position: "absolute",
			width: 30,
			height: 16.8,
			left: "85%",
			top: 6,
			marginLeft: -15,
			zIndex: 0
		};

		// 5:4 竖版钱包 SVG（放在内容区右侧）：鼓起的程度 = 当前余额 ÷ 满额参考（fillPct）。
		// 露出的钞票堆高度随余额变化，纸币从钱包口飞出。
		function walletSvg(fillPct) {
			const stackH = 7 + (31 * fillPct) / 100; // 露出的钞票堆高度 7..38
			return jsx("svg", {
				width: 42,
				height: 33.6,
				viewBox: "0 0 125 100",
				style: { display: "block", position: "relative", zIndex: 2 },
				children: jsxs(Fragment, {
					children: [
						// 钱包主体（先画，被钞票和盖压在下面）
						jsx("rect", { x: 6, y: 27, width: 112, height: 64, rx: 8, fill: "#7a4f26" }),
						// 内衬（开口处深色）
						jsx("rect", { x: 9, y: 27, width: 106, height: 13, rx: 6.5, fill: "#4a2c12" }),
						// 露出的钞票堆（高度 = 进度）
						jsx("rect", { x: 15, y: 42 - stackH, width: 96, height: stackH, rx: 1.5, fill: "#d55f6f" }),
						jsx("rect", { x: 15, y: 42 - stackH + 9, width: 96, height: 1, fill: "rgba(255,255,255,0.35)" }),
						jsx("rect", { x: 15, y: 42 - stackH + 17, width: 96, height: 1, fill: "rgba(255,255,255,0.28)" }),
						jsx("rect", { x: 15, y: 42 - stackH + 26, width: 96, height: 1, fill: "rgba(255,255,255,0.2)" }),
						jsx("rect", { x: 15, y: 42 - stackH + 34, width: 96, height: 1, fill: "rgba(255,255,255,0.16)" }),
						// 钱包盖（压住开口，露出上方的钞票）
						jsx("rect", { x: 6, y: 27, width: 112, height: 10, rx: 5, fill: "#6b4423" }),
						// 缝线
						jsx("rect", { x: 9, y: 32, width: 106, height: 51, rx: 8, fill: "none", stroke: "#3f2a10", strokeWidth: 0.8, strokeDasharray: "3 3", opacity: 0.6 }),
						// 按扣
						jsx("circle", { cx: 63, cy: 32, r: 3.1, fill: "#c9a86a", stroke: "#8a6a3a", strokeWidth: 0.6 })
					]
				})
			});
		}

		// 百元人民币票面（按用户设计精简缩放的 SVG；id 带后缀避免多张重复）。
		// folded 为 true 时右下角带折叠缺角（随机出现，营造折叠/卷曲感）。
		function billSvg(idSuffix, folded) {
			return jsx("svg", {
				width: 30,
				height: 16.8,
				viewBox: "0 0 680 380",
				xmlns: "http://www.w3.org/2000/svg",
				style: { display: "block" },
				children: jsxs(Fragment, {
					children: [
						jsx("defs", {
							children: jsxs(Fragment, {
								children: [
									jsx("linearGradient", {
										id: `dsh-bill-grad-${idSuffix}`,
										x1: "0%", y1: "0%", x2: "100%", y2: "0%",
										children: jsxs(Fragment, {
											children: [
												jsx("stop", { offset: "0%", stopColor: "#f6e4e7" }),
												jsx("stop", { offset: "12%", stopColor: "#f1d4db" }),
												jsx("stop", { offset: "40%", stopColor: "#e68d9c" }),
												jsx("stop", { offset: "75%", stopColor: "#d56478" }),
												jsx("stop", { offset: "100%", stopColor: "#b6394f" })
											]
										})
									}),
									jsx("pattern", {
										id: `dsh-bill-guilloche-${idSuffix}`,
										patternUnits: "userSpaceOnUse",
										width: 6,
										height: 6,
										children: jsxs(Fragment, {
											children: [
												jsx("path", { d: "M 0 0 L 6 6 M 6 0 L 0 6", stroke: "rgba(180,60,70,0.15)", strokeWidth: 0.5 }),
												jsx("circle", { cx: 3, cy: 3, r: 1.5, fill: "rgba(255,255,255,0.05)" })
											]
										})
									})
								]
							})
						}),
						jsx("rect", { width: 680, height: 380, rx: 8, ry: 8, fill: `url(#dsh-bill-grad-${idSuffix})` }),
						jsx("rect", { width: 680, height: 380, rx: 8, ry: 8, fill: `url(#dsh-bill-guilloche-${idSuffix})` }),
						jsx("rect", { x: 1, y: 1, width: 678, height: 378, rx: 7, ry: 7, fill: "none", stroke: "#4a4a4a", strokeWidth: 1.5, opacity: 0.5 }),
						jsx("rect", { x: 0, y: 0, width: 130, height: 380, fill: "#fcfbfa", opacity: 0.85 }),
						jsx("text", { x: 185, y: 155, fontFamily: "SimHei, sans-serif", fontWeight: "bold", fill: "#402821", fontSize: 78, children: "100" }),
						jsx("circle", { cx: 265, cy: 220, r: 40, fill: "#c42834" }),
						jsx("circle", { cx: 265, cy: 220, r: 28, fill: "#8a1d50" }),
						jsx("circle", { cx: 265, cy: 220, r: 16, fill: "#e64453" }),
						jsx("rect", { x: 645, y: 0, width: 10, height: 380, fill: "#1c1c1c" }),
						jsx("rect", { x: 647, y: 15, width: 6, height: 40, fill: "#bdcad6" }),
						jsx("rect", { x: 647, y: 70, width: 6, height: 40, fill: "#bdcad6" }),
						jsx("rect", { x: 647, y: 125, width: 6, height: 40, fill: "#bdcad6" }),
						jsx("rect", { x: 647, y: 180, width: 6, height: 40, fill: "#bdcad6" }),
						jsx("rect", { x: 647, y: 235, width: 6, height: 40, fill: "#bdcad6" }),
						jsx("rect", { x: 647, y: 290, width: 6, height: 40, fill: "#bdcad6" }),
						// 右下角折叠缺角（随机出现）：暗红 flap（纸背）+ 内侧阴影 + 折痕线
						...(!folded ? [] : [
							jsx("polygon", { points: "560,380 680,380 680,260", fill: "#d56478" }),
							jsx("polygon", { points: "560,380 680,260 680,282", fill: "rgba(90,20,35,0.35)" }),
							jsx("path", { d: "M560 380 L680 260", stroke: "rgba(0,0,0,0.35)", strokeWidth: 2, fill: "none" })
						])
					]
				})
			});
		}

		const footer = {
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 10,
			lineHeight: "14px",
			fontVariantNumeric: "tabular-nums"
		};

		const errorText = {
			color: "var(--dsw-alias-state-error-primary)",
			fontSize: 11,
			lineHeight: "16px",
			wordBreak: "break-all",
			marginBottom: 6
		};

		const loadingText = {
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			lineHeight: "18px",
			marginBottom: 6
		};

		// 最小化后的小方块（可拖动，点击展开）。
		const tile = {
			position: "absolute",
			right: 16,
			bottom: 16,
			zIndex: 30,
			pointerEvents: "auto",
			boxSizing: "border-box",
			width: 48,
			height: 48,
			borderRadius: 12,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-overlay)",
			boxShadow: "0 4px 16px rgba(0, 0, 0, 0.16)",
			color: "var(--dsw-alias-label-primary)",
			display: "flex",
			flexDirection: "column",
			alignItems: "center",
			justifyContent: "center",
			gap: 2,
			cursor: "pointer",
			userSelect: "none",
			touchAction: "none"
		};

		const tileBalance = {
			fontSize: 10,
			lineHeight: "14px",
			fontWeight: 600,
			fontVariantNumeric: "tabular-nums",
			whiteSpace: "nowrap",
			maxWidth: 42,
			overflow: "hidden",
			textOverflow: "ellipsis"
		};

		// 注入 @keyframes（浏览器 bundle 无法用内联样式定义关键帧）。
		// 6 组"从钱包口被风吹起"的轨迹：全部只向上（Y 位移 <= 0），左右位移低频温和（每条约 1~2 次回摆），
		// 旋转来回抖 + 纸片颤动（scale 微幅起伏）保留灵动感，循环无缝衔接、无停顿。
		function ensureKeyframes() {
			if (document.getElementById(FLY_KEYFRAMES_ID) !== null) return;
			const style = document.createElement("style");
			style.id = FLY_KEYFRAMES_ID;
			style.textContent = [
				"@keyframes dsh-quota-spin { to { transform: rotate(360deg); } }",
				"@keyframes dsh-quota-fly1 { 0% { transform: translate(0px,0px) rotate(0deg) scale(1); opacity: 0.85; } 12% { transform: translate(9px,-10px) rotate(8deg) scale(1.02); opacity: 0.9; } 25% { transform: translate(18px,-22px) rotate(-9deg) scale(0.98); opacity: 0.9; } 38% { transform: translate(26px,-36px) rotate(7deg) scale(1); opacity: 0.8; } 50% { transform: translate(30px,-50px) rotate(-6deg) scale(0.99); opacity: 0.68; } 62% { transform: translate(26px,-64px) rotate(8deg) scale(0.98); opacity: 0.52; } 75% { transform: translate(30px,-80px) rotate(-5deg) scale(0.99); opacity: 0.35; } 88% { transform: translate(33px,-94px) rotate(4deg) scale(0.97); opacity: 0.15; } 100% { transform: translate(35px,-102px) rotate(-2deg) scale(0.96); opacity: 0; } }",
				"@keyframes dsh-quota-fly2 { 0% { transform: translate(0px,0px) rotate(0deg) scale(1); opacity: 0.8; } 12% { transform: translate(-8px,-10px) rotate(-8deg) scale(1.02); opacity: 0.85; } 25% { transform: translate(-15px,-22px) rotate(9deg) scale(0.98); opacity: 0.85; } 38% { transform: translate(-22px,-36px) rotate(-7deg) scale(1); opacity: 0.75; } 50% { transform: translate(-26px,-50px) rotate(6deg) scale(0.99); opacity: 0.6; } 62% { transform: translate(-22px,-64px) rotate(-8deg) scale(0.98); opacity: 0.45; } 75% { transform: translate(-25px,-80px) rotate(5deg) scale(0.99); opacity: 0.3; } 88% { transform: translate(-28px,-94px) rotate(-4deg) scale(0.97); opacity: 0.12; } 100% { transform: translate(-30px,-102px) rotate(2deg) scale(0.96); opacity: 0; } }",
				"@keyframes dsh-quota-fly3 { 0% { transform: translate(0px,0px) rotate(0deg) scale(1); opacity: 0.85; } 12% { transform: translate(8px,-10px) rotate(60deg) scale(1.01); opacity: 0.85; } 25% { transform: translate(16px,-24px) rotate(130deg) scale(0.99); opacity: 0.8; } 38% { transform: translate(23px,-40px) rotate(190deg) scale(1); opacity: 0.7; } 50% { transform: translate(29px,-56px) rotate(260deg) scale(0.98); opacity: 0.6; } 62% { transform: translate(35px,-72px) rotate(330deg) scale(1); opacity: 0.45; } 75% { transform: translate(40px,-88px) rotate(420deg) scale(0.97); opacity: 0.28; } 88% { transform: translate(44px,-102px) rotate(480deg) scale(0.95); opacity: 0.1; } 100% { transform: translate(47px,-110px) rotate(500deg) scale(0.94); opacity: 0; } }",
				"@keyframes dsh-quota-fly4 { 0% { transform: translate(0px,0px) rotate(-5deg) scale(1); opacity: 0.85; } 12% { transform: translate(3px,-12px) rotate(7deg) scale(1.02); opacity: 0.9; } 25% { transform: translate(6px,-26px) rotate(-8deg) scale(0.98); opacity: 0.88; } 38% { transform: translate(8px,-42px) rotate(6deg) scale(1); opacity: 0.78; } 50% { transform: translate(10px,-58px) rotate(-7deg) scale(0.99); opacity: 0.65; } 62% { transform: translate(12px,-74px) rotate(5deg) scale(1); opacity: 0.5; } 75% { transform: translate(14px,-90px) rotate(-4deg) scale(0.98); opacity: 0.33; } 88% { transform: translate(15px,-104px) rotate(3deg) scale(0.97); opacity: 0.13; } 100% { transform: translate(16px,-112px) rotate(-2deg) scale(0.96); opacity: 0; } }",
				"@keyframes dsh-quota-fly5 { 0% { transform: translate(0px,0px) rotate(0deg) scale(1); opacity: 0.85; } 12% { transform: translate(10px,-20px) rotate(9deg) scale(1.02); opacity: 0.9; } 25% { transform: translate(18px,-48px) rotate(-10deg) scale(0.98); opacity: 0.85; } 38% { transform: translate(25px,-78px) rotate(8deg) scale(1); opacity: 0.7; } 50% { transform: translate(29px,-108px) rotate(-7deg) scale(0.97); opacity: 0.5; } 62% { transform: translate(26px,-132px) rotate(6deg) scale(0.95); opacity: 0.3; } 75% { transform: translate(29px,-150px) rotate(-4deg) scale(0.93); opacity: 0.14; } 88% { transform: translate(31px,-160px) rotate(3deg) scale(0.91); opacity: 0.05; } 100% { transform: translate(32px,-166px) rotate(-2deg) scale(0.9); opacity: 0; } }",
				"@keyframes dsh-quota-fly6 { 0% { transform: translate(0px,0px) rotate(-7deg) scale(1); opacity: 0.85; } 12% { transform: translate(7px,-12px) rotate(9deg) scale(1.02); opacity: 0.9; } 25% { transform: translate(13px,-28px) rotate(-10deg) scale(0.98); opacity: 0.85; } 38% { transform: translate(18px,-46px) rotate(7deg) scale(1); opacity: 0.75; } 50% { transform: translate(22px,-64px) rotate(-8deg) scale(0.99); opacity: 0.6; } 62% { transform: translate(18px,-82px) rotate(6deg) scale(0.98); opacity: 0.45; } 75% { transform: translate(21px,-98px) rotate(-5deg) scale(0.99); opacity: 0.3; } 88% { transform: translate(23px,-110px) rotate(4deg) scale(0.97); opacity: 0.12; } 100% { transform: translate(24px,-118px) rotate(-3deg) scale(0.96); opacity: 0; } }",
				".dsh-quota-btn:hover { opacity: 0.7; }"
			].join("\n");
			document.head.appendChild(style);
		}

		// ---- the widget -------------------------------------------------
		function DeepSeekQuotaBadge(props) {
			const useSessions = props.useSessions;

			const [data, setData] = useState(null);
			const [phase, setPhase] = useState("loading"); // loading | ready | error
			const [message, setMessage] = useState("");
			const [updatedAt, setUpdatedAt] = useState(null);
			const [spinning, setSpinning] = useState(false);
			const [conversation, setConversation] = useState(null); // 会话费用接口的完整返回（含 breakdown）
			const [ui, setUi] = useState(loadUiState);
			const [reference, setReference] = useState(() => readRef()?.reference ?? null);
			// 纸币随机参数：7 张，随机轨迹组/时长/起点位置/大小；负延迟 = 挂载即处于飞行中途，
			// 无初始停车、无停顿，形成连续钱流。
			const [noteSpecs] = useState(() =>
				Array.from({ length: 7 }, (_, i) => ({
					key: `dsh-quota-fly${1 + Math.floor(Math.random() * 6)}`,
					duration: `${(2 + Math.random() * 2.2).toFixed(1)}s`,
					delay: `-${(i * 0.45 + Math.random() * 0.2).toFixed(2)}s`,
					top: Math.round(40 + Math.random() * 14),
					left: `${(15 + Math.random() * 50).toFixed(1)}%`,
					scale: +(0.85 + Math.random() * 0.3).toFixed(2),
					folded: Math.random() < 0.5
				}))
			);
			// 当前会话 id（SessionListState.current）与该会话是否正在运行（agent 思考/执行中）。
			// 必须在下方所有 useEffect 之前声明（const 的暂时性死区限制）。
			const currentSessionId = typeof useSessions === "function" ? useSessions((s) => s.current) : void 0;
			const busy =
				typeof useSessions === "function"
					? useSessions((s) => (s.current === void 0 ? false : s.byId[s.current]?.running === true))
					: false;
			// 停止泄放：思考结束时不打断在飞的纸币，让它们飞完当前一轮，在循环边界才消失。
			const [draining, setDraining] = useState(false);
			const [stoppedNotes, setStoppedNotes] = useState(() => new Set());
			const wasBusyRef = useRef(false);
			useEffect(() => {
				if (busy) {
					wasBusyRef.current = true;
					setDraining(false);
					setStoppedNotes(new Set());
				} else if (wasBusyRef.current) {
					wasBusyRef.current = false;
					setDraining(true);
				}
			}, [busy]);

			const onNoteIteration = (i) => {
				if (!draining) return;
				setStoppedNotes((prev) => {
					if (prev.has(i)) return prev;
					const next = new Set(prev);
					next.add(i);
					return next;
				});
			};
			const cardRef = useRef(null);
			const dragState = useRef(null);
			const justDragged = useRef(false);

			useEffect(() => {
				ensureKeyframes();
				return () => {
					const el = document.getElementById(FLY_KEYFRAMES_ID);
					if (el !== null) el.remove();
				};
			}, []);

			useEffect(() => {
				try {
					localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(ui ?? {}));
				} catch {}
			}, [ui]);

			// 轮询当前对话费用（宿主按会话日志回放计价，5s 一次，本地路由开销可忽略）。
			useEffect(() => {
				if (currentSessionId === void 0) {
					setConversation(null);
					return;
				}
				let cancelled = false;
				const loadCost = async () => {
					try {
						const res = await fetch(`/api/deepseek-session-cost?sessionId=${encodeURIComponent(currentSessionId)}`, { cache: "no-store" });
						const body = await res.json();
						if (cancelled || body === null || typeof body !== "object" || body.ok !== true) return;
						setConversation(body);
					} catch {}
				};
				loadCost();
				const timer = setInterval(loadCost, 5000);
				return () => {
					cancelled = true;
					clearInterval(timer);
				};
			}, [currentSessionId]);

			const mounted = useRef(true);

			const load = useCallback(async () => {
				setSpinning(true);
				try {
					const result = await fetchBalance();
					if (!mounted.current) return;
					setData(result);
					setPhase("ready");
					setMessage("");
					setUpdatedAt(new Date());
					// 更新充值参考快照，用于进度条满额计算。
					const bal = result.payload && Array.isArray(result.payload.balance_infos) ? result.payload.balance_infos[0] : null;
					const topup = bal ? Number(bal.topped_up_balance) : 0;
					const total = bal ? Number(bal.total_balance) : 0;
					const ref = computeReference(readRef(), Number.isFinite(topup) ? topup : 0, Number.isFinite(total) ? total : 0);
					try {
						localStorage.setItem(REF_STORAGE_KEY, JSON.stringify({
							topup: Number.isFinite(topup) ? topup : 0,
							total: Number.isFinite(total) ? total : 0,
							reference: ref
						}));
					} catch {}
					if (mounted.current) setReference(ref);
				} catch (error) {
					if (!mounted.current) return;
					setPhase("error");
					setMessage(error instanceof Error ? error.message : String(error));
				} finally {
					if (mounted.current) setSpinning(false);
				}
			}, []);

			useEffect(() => {
				mounted.current = true;
				load();
				const timer = setInterval(load, POLL_MS);
				return () => {
					mounted.current = false;
					clearInterval(timer);
				};
			}, [load]);

			const payload = data ? data.payload : null;
			const balance = payload && Array.isArray(payload.balance_infos) ? payload.balance_infos[0] : null;
			const available = payload ? payload.is_available !== false : null;
			const currency = balance ? balance.currency : "CNY";
			const todayConsumed = data ? data.todayConsumed : null;

			const conversationCost = conversation && typeof conversation.cost === "number" ? conversation.cost : null;

			const stateColor =
				phase === "error"
					? "var(--dsw-alias-state-error-primary)"
					: available === false
						? "var(--dsw-alias-state-error-primary)"
						: "var(--dsw-alias-state-success-primary)";

			const balanceNum = balance && Number.isFinite(Number(balance.total_balance)) ? Number(balance.total_balance) : 0;
			// 进度条：当前余额 ÷ 满额参考（最近一次充值金额 + 充值前剩余余额）。充值后从 100% 起，随消费下降。
			const refNum = reference !== null && Number.isFinite(reference) && reference > 0 ? reference : null;
			const fillPct = refNum !== null ? Math.min(100, Math.max(0, Math.round((balanceNum / refNum) * 100))) : 0;

			// ---- 拖动与最小化 -------------------------------------------
			const anchored = ui !== null && typeof ui.x === "number" && typeof ui.y === "number";
			const minimized = ui !== null && ui.minimized === true;
			const cardStyle = {
				...card,
				...(anchored ? { left: ui.x, top: ui.y, right: "auto", bottom: "auto" } : {})
			};

			const onHandlePointerDown = (e) => {
				if (e.button !== 0) return;
				if (e.target.closest && e.target.closest("button")) return;
				const el = cardRef.current;
				if (!el) return;
				const rect = el.getBoundingClientRect();
				const base =
					ui !== null && typeof ui.x === "number" && typeof ui.y === "number"
						? { x: ui.x, y: ui.y }
						: { x: rect.left, y: rect.top };
				dragState.current = {
					pointerId: e.pointerId,
					startX: e.clientX,
					startY: e.clientY,
					baseX: base.x,
					baseY: base.y,
					moved: false
				};
				justDragged.current = false;
				try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
				e.preventDefault();
			};

			const onHandlePointerMove = (e) => {
				const d = dragState.current;
				if (!d || d.pointerId !== e.pointerId) return;
				const dx = e.clientX - d.startX;
				const dy = e.clientY - d.startY;
				if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD_PX) return;
				d.moved = true;
				justDragged.current = true;
				const w = cardRef.current ? cardRef.current.offsetWidth : 260;
				const h = cardRef.current ? cardRef.current.offsetHeight : 150;
				const x = Math.min(Math.max(d.baseX + dx, 48 - w), window.innerWidth - 48);
				const y = Math.min(Math.max(d.baseY + dy, 0), window.innerHeight - 24);
				setUi((prev) => ({ ...(prev ?? {}), x: Math.round(x), y: Math.round(y) }));
			};

			const onHandlePointerUp = (e) => {
				const d = dragState.current;
				if (d && d.pointerId === e.pointerId) {
					dragState.current = null;
					try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
				}
			};

			const onMinimizeClick = () => {
				setUi((prev) => ({ ...(prev ?? {}), minimized: true }));
			};

			const onTileClick = () => {
				if (justDragged.current) {
					justDragged.current = false;
					return;
				}
				setUi((prev) => ({ ...(prev ?? {}), minimized: false }));
			};

			// ---- 图标 ----------------------------------------------------
			const refreshIcon = jsx("svg", {
				width: 14,
				height: 14,
				viewBox: "0 0 16 16",
				fill: "none",
				style: spinning ? { animation: "dsh-quota-spin 0.8s linear infinite" } : void 0,
				children: jsx("path", {
					d: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinecap: "round",
					strokeLinejoin: "round"
				})
			});

			const minimizeIcon = jsx("svg", {
				width: 14,
				height: 14,
				viewBox: "0 0 16 16",
				fill: "none",
				children: jsx("path", {
					d: "M4 8h8",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinecap: "round"
				})
			});

			// ---- 最小化小方块 --------------------------------------------
			if (minimized) {
				const tileText =
					phase === "error"
						? "!"
						: phase === "loading"
							? "…"
							: balance
								? formatBalance(balance.total_balance, currency)
								: "¥";
				return jsx("div", {
					role: "status",
					"aria-live": "polite",
					"data-plugin": "dsh-deepseek-quota",
					title: phase === "error" ? `DeepSeek 额度：${message}` : "DeepSeek 额度（点击展开）",
					ref: cardRef,
					onPointerDown: onHandlePointerDown,
					onPointerMove: onHandlePointerMove,
					onPointerUp: onHandlePointerUp,
					onClick: onTileClick,
					style: {
						...tile,
						...(anchored ? { left: ui.x, top: ui.y, right: "auto", bottom: "auto" } : {})
					},
					children: jsxs(Fragment, {
						children: [
							jsx("span", { style: { ...dot, background: phase === "loading" ? "var(--dsw-alias-label-secondary)" : stateColor }, "aria-hidden": true }),
							jsx("span", { style: tileBalance, children: tileText })
						]
					})
				});
			}

			// ---- 完整卡片 ------------------------------------------------
			const tagText = phase === "error" ? "错误" : phase === "loading" ? "…" : available === false ? "不可用" : "余额";

			return jsx("div", {
				role: "status",
				"aria-live": "polite",
				"data-plugin": "dsh-deepseek-quota",
				title: "DeepSeek 余额显示（进度条 = 当前余额 ÷ 最近一次充值后的满额）",
				ref: cardRef,
				onPointerDown: onHandlePointerDown,
				onPointerMove: onHandlePointerMove,
				onPointerUp: onHandlePointerUp,
				style: cardStyle,
				children: jsxs(Fragment, {
					children: [
						jsxs("div", {
							style: headerRow,
							children: [
								jsxs("div", {
									style: title,
									children: [
										jsx("span", { style: { ...dot, background: phase === "loading" ? "var(--dsw-alias-label-secondary)" : stateColor }, "aria-hidden": true }),
										jsx("span", { children: "DeepSeek 余额显示" })
									]
								}),
								jsxs("div", {
									style: actions,
									children: [
										jsx("button", {
											type: "button",
											className: "dsh-quota-btn",
											style: iconBtn,
											"aria-label": "刷新余额",
											title: "刷新",
											disabled: spinning,
											onPointerDown: (e) => { e.stopPropagation(); },
											onClick: () => { load(); },
											children: refreshIcon
										}),
										jsx("button", {
											type: "button",
											className: "dsh-quota-btn",
											style: iconBtn,
											"aria-label": "最小化余额卡片",
											title: "最小化",
											onPointerDown: (e) => { e.stopPropagation(); },
											onClick: onMinimizeClick,
											children: minimizeIcon
										})
									]
								})
							]
						}),
						phase === "loading"
							? jsx("div", { style: loadingText, children: "加载中…" })
							: phase === "error"
								? jsx("div", { style: errorText, title: message, children: message })
								: jsxs(Fragment, {
									children: [
										jsxs("div", {
											style: contentRow,
											children: [
												jsxs("div", {
													style: contentCol,
													children: [
														jsxs("div", {
															style: balanceRow,
															children: [
																jsx("span", { style: amount, children: balance ? formatBalance(balance.total_balance, currency) : "—" }),
																jsx("span", { style: { ...tag, color: stateColor }, children: tagText })
															]
														}),
														jsxs("div", {
															style: statsRow,
															children: [
																jsx("span", { children: `当前对话已用：${conversationCost !== null ? formatBalance(Number(conversationCost).toFixed(2), currency) : "—"}` }),
																jsx("span", { children: `今日已用：${todayConsumed !== null ? formatBalance(todayConsumed, currency) : "—"}` })
															]
														}),
														jsx("div", { style: footer, children: updatedAt ? `更新于 ${formatTime(updatedAt)}` : "更新于 --:--:--" })
													]
												}),
												jsxs("div", {
													style: walletBox,
													children: [
														...noteSpecs.map((n, i) => {
															const stopped = stoppedNotes.has(i);
															const show = busy || (draining && !stopped);
															return jsx("div", {
																style: {
																	...flyingNote,
																	left: n.left,
																	top: n.top,
																	transform: `scale(${n.scale})`
																},
																children: jsx("div", {
																	style: {
																		width: "100%",
																		height: "100%",
																		opacity: show ? 0.9 : 0,
																		transition: "opacity 0.4s ease",
																		animation: show ? `${n.key} ${n.duration} infinite linear` : "none",
																		animationDelay: n.delay,
																		willChange: "transform"
																	},
																	onAnimationIteration: () => onNoteIteration(i),
																	children: billSvg(i, n.folded)
																})
															});
														}),
														walletSvg(fillPct)
													]
												})
											]
										}),
									]
								})
					]
				})
			});
		}

		// ---- client plugin body -----------------------------------------
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "deepseek-quota",
				order: 100,
				label: "DeepSeek 额度"
			}, DeepSeekQuotaBadge));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
