import {
	App,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	MarkdownRenderer,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TextAreaComponent,
	TextComponent,
	ToggleComponent,
	setIcon,
	moment,
} from 'obsidian';
import { t } from './i18n';

export interface CRVariable {
	name: string;
	type: 'string' | 'number' | 'boolean';
	value: string;
}

export type CRHiddenStyle =
	| 'none'
	| 'text'
	| 'text-grey'
	| 'text-gray'
	| 'text-red'
	| 'text-blue'
	| 'text-green'
	| 'text-white'
	| 'text-yellow'
	| 'text-rainbow'
	| 'underline'
	| 'blank'
	| 'spoiler'
	| 'spoiler-white'
	| 'spoiler-round'
	| 'spoiler-white-round';

type CRInputValueType = 'string' | 'number' | 'boolean';
type CRInputControlType = 'string' | 'number' | 'boolean' | 'textarea' | 'select' | 'calendar';
type CRInputOptionValue = string | number | boolean | string[];
type CRControlElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
type CRInputSyntaxMode = 'typed' | 'legacy';

interface ConditionalRenderSettings {
	identifier: string;
	hiddenStyle: CRHiddenStyle;
	hiddenCustomText: string;
	defaultVariable: string;
	variables: CRVariable[];
}

interface ParsedInputSpec {
	mode: CRInputSyntaxMode;
	raw: string;
	target: string;
	targetKind: 'yaml' | 'global';
	explicitControlType?: CRInputControlType;
	options: Record<string, CRInputOptionValue>;
}

interface InputBinding {
	sourcePath: string;
	spec: ParsedInputSpec;
}

interface InputState {
	isEditing: boolean;
	isComposing: boolean;
	pendingCommitTimer: number | null;
}

interface DynamicRenderBinding {
	sourcePath: string;
	kind: 'inline-expression' | 'inline-default' | 'inline-conditional' | 'block';
	style?: CRHiddenStyle;
	expression?: string;
	rawContent?: string;
	hiddenTextOverride?: string;
	condition?: string;
	trueContent?: string;
	falseContent?: string;
	hasElse?: boolean;
}

const DEFAULT_SETTINGS: ConditionalRenderSettings = {
	identifier: 'cr',
	hiddenStyle: 'none',
	hiddenCustomText: '[内容已隐藏]',
	defaultVariable: 'plugin_status',
	variables: [
		{ name: 'plugin_status', type: 'boolean', value: 'true' },
		{ name: 'plugin_name', type: 'string', value: 'Conditional Render' },
	],
};

const SHORT_NAME_MAP: Record<string, CRHiddenStyle> = {
	n: 'none',
	t: 'text',
	tg: 'text-grey',
	tr: 'text-red',
	tb: 'text-blue',
	tgn: 'text-green',
	tw: 'text-white',
	ty: 'text-yellow',
	trb: 'text-rainbow',
	u: 'underline',
	b: 'blank',
	sp: 'spoiler',
	spw: 'spoiler-white',
	spr: 'spoiler-round',
	spwr: 'spoiler-white-round',
};

const ALL_HIDDEN_STYLES: readonly CRHiddenStyle[] = [
	'none',
	'text',
	'text-grey',
	'text-gray',
	'text-red',
	'text-blue',
	'text-green',
	'text-white',
	'text-yellow',
	'text-rainbow',
	'underline',
	'blank',
	'spoiler',
	'spoiler-white',
	'spoiler-round',
	'spoiler-white-round',
];

const INPUT_TYPE_ALIASES: Record<string, CRInputControlType> = {
	bool: 'boolean',
	boolean: 'boolean',
	string: 'string',
	number: 'number',
	textarea: 'textarea',
	select: 'select',
	calendar: 'calendar',
};

const isValidVarName = (name: string) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
const isValidIdentifier = (name: string) => /^[a-zA-Z0-9_-]+$/.test(name);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isTextHiddenStyle = (style: CRHiddenStyle) => [
	'text',
	'text-grey',
	'text-gray',
	'text-red',
	'text-blue',
	'text-green',
	'text-white',
	'text-yellow',
	'text-rainbow',
].includes(style);

const resolveHiddenStyleToken = (token?: string | null): CRHiddenStyle | null => {
	if (!token) return null;
	if (ALL_HIDDEN_STYLES.includes(token as CRHiddenStyle)) return token as CRHiddenStyle;
	return SHORT_NAME_MAP[token] ?? null;
};

class CRInputChild extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private readonly inputEl: CRControlElement,
		private readonly plugin: ConditionalRenderPlugin,
	) {
		super(containerEl);
	}

	onload() {
		this.plugin.scheduleSyncForInput(this.inputEl, { immediate: true, delayed: true });
	}
}

export default class ConditionalRenderPlugin extends Plugin {
	settings!: ConditionalRenderSettings;
	private readonly inputBindings = new WeakMap<CRControlElement, InputBinding>();
	private readonly inputStates = new WeakMap<CRControlElement, InputState>();
	private readonly dynamicRenderBindings = new WeakMap<HTMLElement, DynamicRenderBinding>();
	private readonly dynamicRenderElements = new Set<HTMLElement>();
	private readonly expressionFnCache = new Map<string, Function | null>();
	private refreshTimer: number | null = null;
	private dynamicRefreshRaf: number | null = null;
	private dynamicRefreshFallbackTimer: number | null = null;
	private pendingDynamicRefreshAll = false;
	private readonly pendingDynamicRefreshPaths = new Set<string>();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new CRSettingTab(this.app, this));
		console.log(t('log_loaded').replace('0.12.0', '0.15.5'));

		this.registerProcessors();

		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				this.scheduleSyncByPath(file.path, { immediate: true, delayed: true });
				this.scheduleDynamicRefresh(file.path);
			}),
		);
	}

	onunload() {
		console.log(t('log_unloaded'));
	}

	getDefaultVariable(): string {
		const defaultVar = this.settings.defaultVariable;
		if (defaultVar && this.settings.variables.some((v) => v.name === defaultVar)) {
			return defaultVar;
		}
		return this.settings.variables.length > 0 ? this.settings.variables[0].name : 'true';
	}

	registerProcessors() {
		const id = this.settings.identifier;

		this.registerCodeBlock(id, null);
		ALL_HIDDEN_STYLES.forEach((style) => this.registerCodeBlock(`${id}-${style}`, style));
		Object.entries(SHORT_NAME_MAP).forEach(([short, full]) => this.registerCodeBlock(`${id}-${short}`, full));

		this.registerMarkdownPostProcessor((element, context) => {
			const codeBlocks = Array.from(element.querySelectorAll('code'));
			let hasDynamicWork = false;

			for (const code of codeBlocks) {
				if (code.parentElement?.tagName === 'PRE') continue;
				const text = code.innerText.trim();
				if (!text) continue;

				if (this.tryRenderInteractiveInput(code as HTMLElement, text, context)) {
					hasDynamicWork = true;
					continue;
				}

				const inlineIfRegex = new RegExp(`^${escapeRegex(id)}if(?:-([a-z-]+))?:\\s*([\\s\\S]*)$`);
				const inlineIfMatch = text.match(inlineIfRegex);
				if (inlineIfMatch) {
					const styleToken = inlineIfMatch[1];
					const activeStyle = resolveHiddenStyleToken(styleToken) ?? this.settings.hiddenStyle;
					const parsedInlineConditional = this.parseInlineConditionalSyntax(
						inlineIfMatch[2].trim(),
						isTextHiddenStyle(activeStyle),
					);
					if (!parsedInlineConditional.ok) {
						this.renderInlineSyntaxError(code as HTMLElement, parsedInlineConditional.message);
						continue;
					}

					const span = document.createElement('span');
					code.replaceWith(span);
					this.registerDynamicRender(span, {
						sourcePath: context.sourcePath,
						kind: 'inline-conditional',
						condition: parsedInlineConditional.value.condition,
						rawContent: parsedInlineConditional.value.visibleText,
						hiddenTextOverride: parsedInlineConditional.value.hiddenTextOverride,
						style: activeStyle,
					});
					this.refreshDynamicRender(span);
					hasDynamicWork = true;
					continue;
				}

				const regex = new RegExp(`^${escapeRegex(id)}(?:-([a-z-]+))?(:)?\\s*([\\s\\S]*)$`);
				const match = text.match(regex);
				if (!match) continue;

				const inlineStyle = match[1];
				const hasColon = !!match[2];
				const expressionRaw = match[3].trim();
				const activeStyle = resolveHiddenStyleToken(inlineStyle) ?? this.settings.hiddenStyle;

				const span = document.createElement('span');
				code.replaceWith(span);

				if (hasColon) {
					this.registerDynamicRender(span, {
						sourcePath: context.sourcePath,
						kind: 'inline-expression',
						expression: expressionRaw,
					});
				} else {
					const parsedInlineDefault = this.parseInlineDefaultHiddenOverride(expressionRaw, activeStyle);
					this.registerDynamicRender(span, {
						sourcePath: context.sourcePath,
						kind: 'inline-default',
						rawContent: parsedInlineDefault.visibleText,
						hiddenTextOverride: parsedInlineDefault.hiddenTextOverride,
						style: activeStyle,
					});
				}
				this.refreshDynamicRender(span);
				hasDynamicWork = true;
			}

			if (hasDynamicWork) {
				this.scheduleDynamicRefresh(context.sourcePath);
			}
		});
	}

	private tryRenderInteractiveInput(codeEl: HTMLElement, text: string, context: MarkdownPostProcessorContext): boolean {
		const prefix = `${this.settings.identifier}-input`;
		if (!text.startsWith(prefix)) return false;

		const remainder = text.slice(prefix.length);
		const isTypedSyntax = remainder.trimStart().startsWith(':');
		const rawSpec = isTypedSyntax ? remainder.trimStart().slice(1).trim() : remainder.trim();
		const parsed = this.parseInputSpec(rawSpec, isTypedSyntax ? 'typed' : 'legacy');

		if (!parsed.ok) {
			this.renderInputError(codeEl, parsed.message);
			return true;
		}

		this.renderInteractiveInput(codeEl, parsed.value, context);
		return true;
	}

	registerCodeBlock(lang: string, overrideStyle: CRHiddenStyle | null) {
		this.registerMarkdownCodeBlockProcessor(lang, (source, el, ctx) => {
			const id = this.settings.identifier;
			const lines = source.split('\n');

			let condition = '';
			const trueContent: string[] = [];
			const falseContent: string[] = [];
			let currentMode: 'true' | 'false' = 'true';
			let hasIf = false;
			let hasElse = false;

			const ifPrefix = `${id}if:`;
			const elsePrefix = `${id}else:`;

			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed.startsWith(ifPrefix)) {
					condition = trimmed.slice(ifPrefix.length).trim();
					hasIf = true;
				} else if (trimmed.startsWith(elsePrefix)) {
					currentMode = 'false';
					hasElse = true;
				} else if (currentMode === 'true') {
					trueContent.push(line);
				} else {
					falseContent.push(line);
				}
			}

			if (!hasIf && this.settings.variables.length > 0) {
				condition = this.getDefaultVariable();
			} else if (!hasIf) {
				condition = 'true';
			}

			let activeStyle = this.settings.hiddenStyle;
			if (overrideStyle) activeStyle = resolveHiddenStyleToken(overrideStyle) ?? overrideStyle;

			const container = el.createDiv();
			this.registerDynamicRender(container, {
				sourcePath: ctx.sourcePath,
				kind: 'block',
				condition,
				trueContent: trueContent.join('\n'),
				falseContent: falseContent.join('\n'),
				hasElse,
				style: activeStyle,
			});
			this.refreshDynamicRender(container);
			this.scheduleDynamicRefresh(ctx.sourcePath);
		});
	}

	private detachDynamicDescendants(containerEl: HTMLElement) {
		for (const element of Array.from(this.dynamicRenderElements)) {
			if (containerEl.contains(element)) {
				this.dynamicRenderElements.delete(element);
			}
		}
	}

	private clearDynamicContainer(containerEl: HTMLElement) {
		this.detachDynamicDescendants(containerEl);
		containerEl.className = '';
		containerEl.style.display = '';
		containerEl.removeAttribute('title');
		containerEl.empty();
	}

	private renderDynamicMarkdown(containerEl: HTMLElement, markdown: string, sourcePath: string) {
		return MarkdownRenderer.renderMarkdown(markdown, containerEl, sourcePath, this);
	}

	private applyTextHiddenVariantStyle(containerEl: HTMLElement, style: CRHiddenStyle) {
		containerEl.style.color = '';
		containerEl.style.backgroundImage = '';
		containerEl.style.webkitBackgroundClip = '';
		containerEl.style.backgroundClip = '';
		containerEl.style.webkitTextFillColor = '';

		switch (style) {
			case 'text-red':
				containerEl.style.color = 'var(--text-error, #e74c3c)';
				break;
			case 'text-blue':
				containerEl.style.color = 'var(--text-accent, #4f8cff)';
				break;
			case 'text-green':
				containerEl.style.color = 'var(--text-success, #2ecc71)';
				break;
			case 'text-white':
				containerEl.style.color = '#ffffff';
				break;
			case 'text-yellow':
				containerEl.style.color = '#f1c40f';
				break;
			case 'text-rainbow':
				containerEl.style.backgroundImage = 'linear-gradient(90deg, #ff4d4f, #faad14, #52c41a, #1890ff, #722ed1)';
				containerEl.style.webkitBackgroundClip = 'text';
				containerEl.style.backgroundClip = 'text';
				containerEl.style.webkitTextFillColor = 'transparent';
				containerEl.style.color = 'transparent';
				break;
			default:
				break;
		}
	}

	private getHiddenReplacementText(overrideText?: string): string {
		return overrideText && overrideText.trim() ? overrideText : this.settings.hiddenCustomText;
	}

	private parseInlineDefaultHiddenOverride(rawContent: string, style: CRHiddenStyle): { visibleText: string; hiddenTextOverride?: string } {
		if (!isTextHiddenStyle(style)) return { visibleText: rawContent };
		const segments = this.splitTopLevelPipe(rawContent, 2);
		if (segments.length < 2) return { visibleText: rawContent };
		return {
			visibleText: segments[0].trim(),
			hiddenTextOverride: segments[1].trim(),
		};
	}

	private parseInlineConditionalSyntax(
		raw: string,
		allowHiddenOverride: boolean,
	):
		| { ok: true; value: { condition: string; visibleText: string; hiddenTextOverride?: string } }
		| { ok: false; message: string } {
		const segments = this.splitTopLevelPipe(raw, allowHiddenOverride ? 3 : 2).map((segment) => segment.trim());
		if (segments.length < 2 || !segments[0] || !segments[1]) {
			return { ok: false, message: `Invalid inline conditional syntax. Use ${this.settings.identifier}if: condition | text` };
		}
		const value: { condition: string; visibleText: string; hiddenTextOverride?: string } = {
			condition: segments[0],
			visibleText: segments[1],
		};
		if (allowHiddenOverride && segments[2]) {
			value.hiddenTextOverride = segments[2];
		}
		return { ok: true, value };
	}

	private splitTopLevelPipe(input: string, maxParts = 3): string[] {
		const parts: string[] = [];
		let current = '';
		let depth = 0;
		let quote: '"' | "'" | null = null;
		let escapeNext = false;

		for (let index = 0; index < input.length; index += 1) {
			const char = input[index];
			const prev = index > 0 ? input[index - 1] : '';
			const next = index + 1 < input.length ? input[index + 1] : '';

			if (escapeNext) {
				current += char;
				escapeNext = false;
				continue;
			}
			if (char === '\\') {
				current += char;
				escapeNext = true;
				continue;
			}
			if (quote) {
				current += char;
				if (char === quote) quote = null;
				continue;
			}
			if (char === '"' || char === "'") {
				quote = char as '"' | "'";
				current += char;
				continue;
			}
			if (char === '(') {
				depth += 1;
				current += char;
				continue;
			}
			if (char === ')') {
				depth = Math.max(0, depth - 1);
				current += char;
				continue;
			}
			if (char === '|' && prev !== '|' && next !== '|' && depth === 0 && parts.length < maxParts - 1) {
				parts.push(current);
				current = '';
				continue;
			}
			current += char;
		}

		parts.push(current);
		return parts;
	}

	private renderInlineSyntaxError(codeEl: HTMLElement, message: string) {
		const span = document.createElement('span');
		span.addClass('cr-hidden-text-grey');
		span.textContent = `⚠ CR Syntax Error: ${message}`;
		codeEl.replaceWith(span);
	}

	private renderHiddenInlineInto(
		containerEl: HTMLElement,
		style: CRHiddenStyle,
		originalText: string,
		sourcePath: string,
		hiddenTextOverride?: string,
	) {
		this.clearDynamicContainer(containerEl);

		if (style === 'none') {
			containerEl.style.display = 'none';
			return;
		}

		containerEl.title = originalText;
		if (isTextHiddenStyle(style)) {
			containerEl.className = style === 'text-grey' || style === 'text-gray' ? 'cr-hidden-text-grey' : 'cr-hidden-text';
			MarkdownRenderer.renderMarkdown(this.getHiddenReplacementText(hiddenTextOverride), containerEl, sourcePath, this).then(() => {
				const p = containerEl.querySelector('p');
				if (p) containerEl.innerHTML = p.innerHTML;
				this.applyTextHiddenVariantStyle(containerEl, style);
			});
			return;
		}

		containerEl.className = `cr-hidden-${style}`;
		containerEl.textContent = originalText;
	}

	private renderHiddenBlockInto(
		containerEl: HTMLElement,
		style: CRHiddenStyle,
		originalMarkdown: string,
		sourcePath: string,
		hiddenTextOverride?: string,
	) {
		this.clearDynamicContainer(containerEl);

		if (style === 'none') {
			containerEl.style.display = 'none';
			return;
		}

		if (isTextHiddenStyle(style)) {
			containerEl.className = style === 'text-grey' || style === 'text-gray' ? 'cr-block-text-grey' : 'cr-block-text';
			void this.renderDynamicMarkdown(containerEl, this.getHiddenReplacementText(hiddenTextOverride), sourcePath).then(() => {
				this.applyTextHiddenVariantStyle(containerEl, style);
			});
			return;
		}

		containerEl.className = `cr-block-${style}`;
		void this.renderDynamicMarkdown(containerEl, originalMarkdown, sourcePath);
	}

	private registerDynamicRender(element: HTMLElement, binding: DynamicRenderBinding) {
		this.dynamicRenderBindings.set(element, binding);
		this.dynamicRenderElements.add(element);
		element.dataset.crDynamic = 'true';
		element.dataset.crDynamicBinding = JSON.stringify(binding);
	}

	private getDynamicRenderBinding(element: HTMLElement): DynamicRenderBinding | null {
		const existing = this.dynamicRenderBindings.get(element);
		if (existing) return existing;

		const raw = element.dataset.crDynamicBinding;
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as DynamicRenderBinding;
			this.dynamicRenderBindings.set(element, parsed);
			return parsed;
		} catch {
			return null;
		}
	}

	private pruneDynamicRenderElements() {
		for (const element of Array.from(this.dynamicRenderElements)) {
			if (!element.isConnected) {
				this.dynamicRenderElements.delete(element);
			}
		}
	}


	private computeInlineDefaultContent(rawContent: string, sourcePath: string): string {
		let content = this.replaceVariables(rawContent, sourcePath);
		const evalResult = this.evaluateExpression(content, sourcePath);
		if (evalResult !== undefined) {
			content = String(evalResult);
		} else {
			const strMatch = content.match(/^["']([\s\S]*)["']$/);
			if (strMatch) content = strMatch[1];
		}
		return content;
	}

	private refreshDynamicRender(element: HTMLElement) {
		if (!element.isConnected) return;
		const binding = this.getDynamicRenderBinding(element);
		if (!binding) return;

		if (binding.kind === 'inline-expression') {
			this.clearDynamicContainer(element);
			const result = this.evaluateExpression(binding.expression ?? '', binding.sourcePath);
			element.textContent = result !== undefined ? String(result) : `[Error: ${binding.expression ?? ''}]`;
			return;
		}

		if (binding.kind === 'inline-default') {
			const content = this.computeInlineDefaultContent(binding.rawContent ?? '', binding.sourcePath);
			const defaultVar = this.getDefaultVariable();
			const isTrue = !!this.evaluateExpression(defaultVar, binding.sourcePath);
			if (isTrue) {
				this.clearDynamicContainer(element);
				element.textContent = content;
			} else {
				this.renderHiddenInlineInto(element, binding.style ?? this.settings.hiddenStyle, content, binding.sourcePath, binding.hiddenTextOverride);
			}
			return;
		}

		if (binding.kind === 'inline-conditional') {
			const isTrue = !!this.evaluateExpression(binding.condition ?? 'true', binding.sourcePath);
			const content = this.computeInlineDefaultContent(binding.rawContent ?? '', binding.sourcePath);
			if (isTrue) {
				this.clearDynamicContainer(element);
				element.textContent = content;
			} else {
				this.renderHiddenInlineInto(element, binding.style ?? this.settings.hiddenStyle, content, binding.sourcePath, binding.hiddenTextOverride);
			}
			return;
		}

		const isTrue = !!this.evaluateExpression(binding.condition ?? 'true', binding.sourcePath);
		let targetContent = '';
		let shouldRenderHidden = false;
		if (isTrue) {
			targetContent = binding.trueContent ?? '';
		} else if (binding.hasElse) {
			targetContent = binding.falseContent ?? '';
		} else {
			shouldRenderHidden = true;
			targetContent = binding.trueContent ?? '';
		}
		targetContent = this.replaceVariables(targetContent, binding.sourcePath);
		if (!targetContent.trim()) {
			this.clearDynamicContainer(element);
			return;
		}
		if (shouldRenderHidden) {
			this.renderHiddenBlockInto(element, binding.style ?? this.settings.hiddenStyle, targetContent, binding.sourcePath, binding.hiddenTextOverride);
		} else {
			this.clearDynamicContainer(element);
			void this.renderDynamicMarkdown(element, targetContent, binding.sourcePath);
		}
	}

	private refreshDynamicRenders(changedPath?: string) {
		this.pruneDynamicRenderElements();

		const liveElements = Array.from(document.querySelectorAll<HTMLElement>('[data-cr-dynamic="true"]'));
		for (const element of liveElements) {
			const binding = this.getDynamicRenderBinding(element);
			if (!binding) continue;
			if (changedPath && binding.sourcePath !== changedPath) continue;
			this.dynamicRenderElements.add(element);
			this.refreshDynamicRender(element);
		}
	}

	private flushDynamicRefreshQueue() {
		const refreshAll = this.pendingDynamicRefreshAll;
		const paths = refreshAll ? [] : Array.from(this.pendingDynamicRefreshPaths);
		this.pendingDynamicRefreshAll = false;
		this.pendingDynamicRefreshPaths.clear();

		if (this.dynamicRefreshRaf !== null) {
			window.cancelAnimationFrame(this.dynamicRefreshRaf);
			this.dynamicRefreshRaf = null;
		}
		if (this.dynamicRefreshFallbackTimer !== null) {
			window.clearTimeout(this.dynamicRefreshFallbackTimer);
			this.dynamicRefreshFallbackTimer = null;
		}

		if (refreshAll || paths.length === 0) {
			this.refreshDynamicRenders();
			return;
		}

		for (const path of paths) {
			this.refreshDynamicRenders(path);
		}
	}

	private scheduleDynamicRefresh(changedPath?: string) {
		if (changedPath) this.pendingDynamicRefreshPaths.add(changedPath);
		else this.pendingDynamicRefreshAll = true;

		if (this.dynamicRefreshRaf === null) {
			this.dynamicRefreshRaf = window.requestAnimationFrame(() => {
				this.dynamicRefreshRaf = null;
				this.flushDynamicRefreshQueue();
			});
		}

		if (this.dynamicRefreshFallbackTimer !== null) {
			window.clearTimeout(this.dynamicRefreshFallbackTimer);
		}
		this.dynamicRefreshFallbackTimer = window.setTimeout(() => {
			this.dynamicRefreshFallbackTimer = null;
			this.flushDynamicRefreshQueue();
		}, 140);
	}

	private renderInputError(codeEl: HTMLElement, message: string) {
		const span = document.createElement('span');
		span.addClass('cr-hidden-text-grey');
		span.textContent = `⚠ CR Input Error: ${message}`;
		codeEl.replaceWith(span);
	}

	private parseInputSpec(
		rawSpec: string,
		mode: CRInputSyntaxMode,
	): { ok: true; value: ParsedInputSpec } | { ok: false; message: string } {
		const raw = rawSpec.trim();
		if (!raw) {
			return { ok: false, message: 'Empty input target. Example: cr-input: bool(this.done)' };
		}

		if (mode === 'legacy') {
			const target = raw;
			const targetKind = this.getTargetKind(target);
			if (!targetKind) {
				return { ok: false, message: `Invalid legacy target "${target}". Use a variable name or this.key` };
			}
			return {
				ok: true,
				value: {
					mode,
					raw,
					target,
					targetKind,
					options: {},
				},
			};
		}

		const typedMatch = raw.match(/^([a-zA-Z]+)\s*\((.*)\)$/s);
		if (!typedMatch) {
			return {
				ok: false,
				message: 'Invalid typed syntax. Use cr-input: bool(name) / string(name) / number(this.score) / textarea(note) / select(status, options=["a","b"]) / calendar(date, format="YYYY-MM-DD")',
			};
		}

		const rawType = typedMatch[1].toLowerCase();
		const explicitControlType = INPUT_TYPE_ALIASES[rawType];
		if (!explicitControlType) {
			return {
				ok: false,
				message: `Unsupported input type "${rawType}". Allowed: bool, string, number, textarea, select, calendar`,
			};
		}

		const inner = typedMatch[2].trim();
		const items = this.splitTopLevelComma(inner);
		if (items.length === 0 || !items[0]?.trim()) {
			return { ok: false, message: 'Missing target inside typed input. Example: bool(this.done)' };
		}

		const target = items[0].trim();
		const targetKind = this.getTargetKind(target);
		if (!targetKind) {
			return { ok: false, message: `Invalid target "${target}". Use a variable name or this.key` };
		}

		const options: Record<string, CRInputOptionValue> = {};
		for (const rawOption of items.slice(1)) {
			const option = rawOption.trim();
			if (!option) continue;
			const eqIndex = option.indexOf('=');
			if (eqIndex <= 0) {
				return { ok: false, message: `Invalid option "${option}". Use key=value` };
			}
			const key = option.slice(0, eqIndex).trim();
			const valueText = option.slice(eqIndex + 1).trim();
			if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(key)) {
				return { ok: false, message: `Invalid option key "${key}"` };
			}
			options[key] = this.parseOptionValue(valueText);
		}

		if (explicitControlType === 'select') {
			const normalized = this.normalizeSelectOptions(options.options);
			if (!normalized || normalized.length === 0) {
				return { ok: false, message: 'select(...) requires options=["option1","option2"]' };
			}
		}

		if (explicitControlType === 'calendar') {
			const format = this.getCalendarFormat(options);
			if (!format) {
				return { ok: false, message: 'calendar(...) requires a valid format string' };
			}
		}

		return {
			ok: true,
			value: {
				mode,
				raw,
				target,
				targetKind,
				explicitControlType,
				options,
			},
		};
	}

	private getTargetKind(target: string): 'yaml' | 'global' | null {
		if (target.startsWith('this.') && target.length > 5) return 'yaml';
		if (isValidVarName(target)) return 'global';
		return null;
	}

	private splitTopLevelComma(input: string): string[] {
		const result: string[] = [];
		let current = '';
		let depth = 0;
		let quote: '"' | "'" | null = null;
		let escapeNext = false;

		for (const char of input) {
			if (escapeNext) {
				current += char;
				escapeNext = false;
				continue;
			}
			if (char === '\\') {
				current += char;
				escapeNext = true;
				continue;
			}
			if (quote) {
				current += char;
				if (char === quote) quote = null;
				continue;
			}
			if (char === '"' || char === "'") {
				quote = char;
				current += char;
				continue;
			}
			if (char === '(' || char === '[' || char === '{') {
				depth += 1;
				current += char;
				continue;
			}
			if (char === ')' || char === ']' || char === '}') {
				depth = Math.max(0, depth - 1);
				current += char;
				continue;
			}
			if (char === ',' && depth === 0) {
				result.push(current);
				current = '';
				continue;
			}
			current += char;
		}

		if (current) result.push(current);
		return result.map((item) => item.trim()).filter(Boolean);
	}

	private parseOptionValue(raw: string): CRInputOptionValue {
		const trimmed = raw.trim();
		if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
		if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
		const quoted = trimmed.match(/^(["'])([\s\S]*)$/);
		if (quoted) return quoted[2];
		if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
			try {
				const parsed = JSON.parse(trimmed);
				if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
					return parsed;
				}
			} catch {
				// fall through
			}
		}
		return trimmed;
	}

	private normalizeSelectOptions(value: CRInputOptionValue | undefined): string[] | null {
		if (!Array.isArray(value)) return null;
		const normalized = value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
		return normalized.length > 0 ? normalized : null;
	}

	private getCalendarFormat(options: Record<string, CRInputOptionValue>): string {
		const format = options.format;
		return typeof format === 'string' && format.trim() ? format.trim() : 'YYYY-MM-DD';
	}

	private toCalendarInputValue(storedValue: unknown, format: string): string {
		if (storedValue === undefined || storedValue === null || storedValue === '') return '';
		const text = String(storedValue).trim();
		if (!text) return '';

		const strict = moment(text, format, true);
		if (strict.isValid()) return strict.format('YYYY-MM-DD');

		const iso = moment(text, 'YYYY-MM-DD', true);
		if (iso.isValid()) return iso.format('YYYY-MM-DD');

		return '';
	}

	private fromCalendarInputValue(inputValue: string, format: string): string | null {
		const text = inputValue.trim();
		if (!text) return '';
		const parsed = moment(text, 'YYYY-MM-DD', true);
		if (!parsed.isValid()) return null;
		return parsed.format(format);
	}

	private getExplicitValueType(controlType: CRInputControlType): CRInputValueType {
		if (controlType === 'boolean') return 'boolean';
		if (controlType === 'number') return 'number';
		return 'string';
	}

	private getDefaultControlTypeForValueType(valueType: CRInputValueType): CRInputControlType {
		if (valueType === 'boolean') return 'boolean';
		if (valueType === 'number') return 'number';
		return 'string';
	}

	private resolveInputBinding(binding: InputBinding):
		| { ok: true; controlType: CRInputControlType; valueType: CRInputValueType; value: unknown; options: ParsedInputSpec['options'] }
		| { ok: false; message: string } {
		const { spec, sourcePath } = binding;
		const explicitValueType = spec.explicitControlType ? this.getExplicitValueType(spec.explicitControlType) : undefined;

		if (spec.targetKind === 'global') {
			const globalVar = this.settings.variables.find((v) => v.name === spec.target);
			if (!globalVar) {
				return { ok: false, message: `Global variable "${spec.target}" not found in settings` };
			}

			if (explicitValueType && explicitValueType !== globalVar.type) {
				return {
					ok: false,
					message: `Type mismatch for global variable "${spec.target}": settings=${globalVar.type}, input=${explicitValueType}`,
				};
			}

			const valueType = explicitValueType ?? globalVar.type;
			const controlType = spec.explicitControlType ?? this.getDefaultControlTypeForValueType(valueType);
			if (controlType === 'select') {
				const normalized = this.normalizeSelectOptions(spec.options.options);
				if (!normalized || normalized.length === 0) {
					return { ok: false, message: 'select(...) requires options=["option1","option2"]' };
				}
			}

			let value: unknown = globalVar.value;
			if (valueType === 'boolean') value = globalVar.value === 'true';
			else if (valueType === 'number') value = globalVar.value === '' ? '' : Number(globalVar.value);
			return { ok: true, controlType, valueType, value, options: spec.options };
		}

		const yamlKey = spec.target.slice(5).trim();
		const fm = this.getFrontmatter(sourcePath);
		const currentValue = fm[yamlKey];
		const inferredType: CRInputValueType =
			typeof currentValue === 'boolean'
				? 'boolean'
				: typeof currentValue === 'number'
					? 'number'
					: 'string';
		const valueType = explicitValueType ?? inferredType;
		const controlType = spec.explicitControlType ?? this.getDefaultControlTypeForValueType(valueType);
		if (controlType === 'select') {
			const normalized = this.normalizeSelectOptions(spec.options.options);
			if (!normalized || normalized.length === 0) {
				return { ok: false, message: 'select(...) requires options=["option1","option2"]' };
			}
		}

		let value: unknown = currentValue;
		if (value === undefined || value === null) {
			value = valueType === 'boolean' ? false : '';
		}
		if (valueType === 'number' && typeof value === 'number' && !Number.isFinite(value)) value = '';
		if (valueType === 'number' && typeof value === 'string') value = value.trim();
		if (valueType === 'boolean' && typeof value !== 'boolean') value = value === true;
		if (valueType === 'string' && typeof value !== 'string') value = String(value ?? '');

		return { ok: true, controlType, valueType, value, options: spec.options };
	}

	private createControlElement(spec: ParsedInputSpec): CRControlElement {
		if (spec.explicitControlType === 'textarea') {
			const textarea = document.createElement('textarea');
			textarea.className = 'cr-interactive-input';
			textarea.dataset.crControl = 'true';
			return textarea;
		}
		if (spec.explicitControlType === 'select') {
			const select = document.createElement('select');
			select.className = 'cr-interactive-input';
			select.dataset.crControl = 'true';
			return select;
		}
		const input = document.createElement('input');
		input.className = 'cr-interactive-input';
		input.dataset.crControl = 'true';
		return input;
	}

	private renderInteractiveInput(codeEl: HTMLElement, spec: ParsedInputSpec, context: MarkdownPostProcessorContext) {
		const wrapper = document.createElement('span');
		wrapper.style.display = 'inline-flex';
		wrapper.style.alignItems = spec.explicitControlType === 'textarea' ? 'flex-start' : 'center';
		wrapper.style.gap = '4px';

		const controlEl = this.createControlElement(spec);
		wrapper.appendChild(controlEl);
		codeEl.replaceWith(wrapper);

		const binding: InputBinding = {
			sourcePath: context.sourcePath,
			spec,
		};
		this.inputBindings.set(controlEl, binding);
		this.inputStates.set(controlEl, { isEditing: false, isComposing: false, pendingCommitTimer: null });

		this.setupInputListeners(controlEl);
		context.addChild(new CRInputChild(wrapper, controlEl, this));
		this.scheduleSyncForInput(controlEl, { immediate: true, delayed: true });
	}

	private isInputElement(controlEl: CRControlElement): controlEl is HTMLInputElement {
		return controlEl instanceof HTMLInputElement;
	}

	private isTextAreaElement(controlEl: CRControlElement): controlEl is HTMLTextAreaElement {
		return controlEl instanceof HTMLTextAreaElement;
	}

	private isSelectElement(controlEl: CRControlElement): controlEl is HTMLSelectElement {
		return controlEl instanceof HTMLSelectElement;
	}

	private getInputWrapper(controlEl: CRControlElement): HTMLElement | null {
		return controlEl.parentElement;
	}

	private ensureNumberStepperControls(controlEl: CRControlElement) {
		if (!this.isInputElement(controlEl)) return;
		const wrapper = this.getInputWrapper(controlEl);
		if (!wrapper) return;

		wrapper.style.display = 'inline-flex';
		wrapper.style.alignItems = 'center';
		wrapper.style.gap = '4px';

		let decrementBtn = wrapper.querySelector<HTMLButtonElement>('[data-cr-stepper="decrement"]');
		let incrementBtn = wrapper.querySelector<HTMLButtonElement>('[data-cr-stepper="increment"]');

		if (!decrementBtn) {
			decrementBtn = document.createElement('button');
			decrementBtn.type = 'button';
			decrementBtn.dataset.crStepper = 'decrement';
			decrementBtn.textContent = '-';
			this.applyStepperButtonStyle(decrementBtn);
			decrementBtn.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.adjustNumberInput(controlEl, -1);
			});
			wrapper.insertBefore(decrementBtn, controlEl);
		}

		if (!incrementBtn) {
			incrementBtn = document.createElement('button');
			incrementBtn.type = 'button';
			incrementBtn.dataset.crStepper = 'increment';
			incrementBtn.textContent = '+';
			this.applyStepperButtonStyle(incrementBtn);
			incrementBtn.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				void this.adjustNumberInput(controlEl, 1);
			});
			wrapper.appendChild(incrementBtn);
		}
	}

	private clearNumberStepperControls(controlEl: CRControlElement) {
		const wrapper = this.getInputWrapper(controlEl);
		if (!wrapper) return;
		wrapper.querySelectorAll('[data-cr-stepper]').forEach((el) => el.remove());
	}

	private applyStepperButtonStyle(buttonEl: HTMLButtonElement) {
		buttonEl.style.display = 'inline-flex';
		buttonEl.style.alignItems = 'center';
		buttonEl.style.justifyContent = 'center';
		buttonEl.style.width = '24px';
		buttonEl.style.height = '24px';
		buttonEl.style.padding = '0';
		buttonEl.style.lineHeight = '1';
		buttonEl.style.fontSize = '14px';
		buttonEl.style.border = '1px solid var(--background-modifier-border)';
		buttonEl.style.borderRadius = 'var(--radius-s)';
		buttonEl.style.background = 'var(--background-modifier-form-field)';
		buttonEl.style.color = 'var(--text-normal)';
		buttonEl.style.cursor = 'pointer';
	}

	private getNumberConstraints(controlEl: CRControlElement): { min?: number; max?: number; step: number } {
		const options = this.getInputOptions(controlEl);
		const min = typeof options.min === 'number' && Number.isFinite(options.min) ? options.min : undefined;
		const max = typeof options.max === 'number' && Number.isFinite(options.max) ? options.max : undefined;
		const step = typeof options.step === 'number' && Number.isFinite(options.step) && options.step > 0 ? options.step : 1;
		return { min, max, step };
	}

	private clampNumberValue(value: number, constraints: { min?: number; max?: number }): number {
		let next = value;
		if (typeof constraints.min === 'number' && next < constraints.min) next = constraints.min;
		if (typeof constraints.max === 'number' && next > constraints.max) next = constraints.max;
		return next;
	}

	private updateNumberStepperDisabledState(controlEl: CRControlElement, currentValue: number | null) {
		const wrapper = this.getInputWrapper(controlEl);
		if (!wrapper) return;
		const decrementBtn = wrapper.querySelector<HTMLButtonElement>('[data-cr-stepper="decrement"]');
		const incrementBtn = wrapper.querySelector<HTMLButtonElement>('[data-cr-stepper="increment"]');
		const { min, max } = this.getNumberConstraints(controlEl);

		if (decrementBtn) {
			decrementBtn.disabled = currentValue !== null && typeof min === 'number' && currentValue <= min;
			decrementBtn.style.opacity = decrementBtn.disabled ? '0.5' : '1';
			decrementBtn.style.cursor = decrementBtn.disabled ? 'not-allowed' : 'pointer';
		}
		if (incrementBtn) {
			incrementBtn.disabled = currentValue !== null && typeof max === 'number' && currentValue >= max;
			incrementBtn.style.opacity = incrementBtn.disabled ? '0.5' : '1';
			incrementBtn.style.cursor = incrementBtn.disabled ? 'not-allowed' : 'pointer';
		}
	}

	private async adjustNumberInput(controlEl: CRControlElement, direction: -1 | 1) {
		if (!this.isInputElement(controlEl)) return;
		const binding = this.inputBindings.get(controlEl);
		if (!binding) return;

		const resolved = this.resolveInputBinding(binding);
		if (!resolved.ok || resolved.valueType !== 'number') return;

		const constraints = this.getNumberConstraints(controlEl);
		const rawCurrent = resolved.value;
		const current = typeof rawCurrent === 'number' && Number.isFinite(rawCurrent)
			? rawCurrent
			: (typeof constraints.min === 'number' ? constraints.min : 0);
		const nextValue = this.clampNumberValue(current + direction * constraints.step, constraints);

		controlEl.value = String(nextValue);
		await this.commitInputValue(controlEl, nextValue);
		this.updateNumberStepperDisabledState(controlEl, nextValue);
	}

	private setupInputListeners(controlEl: CRControlElement) {
		controlEl.addEventListener('focus', () => {
			const state = this.getInputState(controlEl);
			state.isEditing = true;
		});

		controlEl.addEventListener('blur', () => {
			const state = this.getInputState(controlEl);
			this.flushPendingCommit(controlEl);
			state.isEditing = false;
			state.isComposing = false;
			this.scheduleSyncForInput(controlEl, { immediate: false, delayed: true });
		});

		controlEl.addEventListener('compositionstart', () => {
			if (!this.isTextLikeControl(controlEl)) return;
			const state = this.getInputState(controlEl);
			state.isEditing = true;
			state.isComposing = true;
		});

		controlEl.addEventListener('compositionend', () => {
			if (!this.isTextLikeControl(controlEl)) return;
			const state = this.getInputState(controlEl);
			state.isComposing = false;
			this.scheduleCommit(controlEl);
		});

		controlEl.addEventListener('input', () => {
			if (!this.isTextLikeControl(controlEl)) return;
			this.scheduleCommit(controlEl);
		});

		controlEl.addEventListener('change', () => {
			if (this.isSelectElement(controlEl)) {
				void this.commitInputValue(controlEl);
				return;
			}
			if (this.isInputElement(controlEl) && (controlEl.type === 'checkbox' || controlEl.dataset.crDisplayType === 'calendar')) {
				void this.commitInputValue(controlEl);
				return;
			}
			if (this.isTextLikeControl(controlEl)) {
				this.scheduleCommit(controlEl);
			}
		});

		controlEl.addEventListener('keydown', (event) => {
			event.stopPropagation();
			if (this.isInputElement(controlEl) && controlEl.dataset.crDisplayType === 'number') {
				if (event.key === 'ArrowUp') {
					event.preventDefault();
					void this.adjustNumberInput(controlEl, 1);
					return;
				}
				if (event.key === 'ArrowDown') {
					event.preventDefault();
					void this.adjustNumberInput(controlEl, -1);
					return;
				}
				if (!['Tab', 'Shift', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
					event.preventDefault();
				}
				return;
			}
			if (this.isInputElement(controlEl) && controlEl.type !== 'checkbox' && event.key === 'Enter') {
				controlEl.blur();
			}
		});
		controlEl.addEventListener('click', (event) => event.stopPropagation());
	}

	private getInputState(controlEl: CRControlElement): InputState {
		let state = this.inputStates.get(controlEl);
		if (!state) {
			state = { isEditing: false, isComposing: false, pendingCommitTimer: null };
			this.inputStates.set(controlEl, state);
		}
		return state;
	}

	private isTextLikeControl(controlEl: CRControlElement) {
		if (this.isTextAreaElement(controlEl)) return true;
		if (this.isInputElement(controlEl)) return controlEl.type === 'text' || controlEl.type === 'number';
		return false;
	}

	private getInputOptions(controlEl: CRControlElement): Record<string, CRInputOptionValue> {
		return this.inputBindings.get(controlEl)?.spec.options ?? {};
	}

	private scheduleCommit(controlEl: CRControlElement) {
		const state = this.getInputState(controlEl);
		if (state.isComposing) return;
		if (state.pendingCommitTimer) window.clearTimeout(state.pendingCommitTimer);

		const debounce = this.getInputDebounce(controlEl);
		state.pendingCommitTimer = window.setTimeout(() => {
			state.pendingCommitTimer = null;
			void this.commitInputValue(controlEl);
		}, debounce);
	}

	private flushPendingCommit(controlEl: CRControlElement) {
		const state = this.getInputState(controlEl);
		if (state.pendingCommitTimer) {
			window.clearTimeout(state.pendingCommitTimer);
			state.pendingCommitTimer = null;
			void this.commitInputValue(controlEl);
		}
	}

	private getInputDebounce(controlEl: CRControlElement): number {
		const binding = this.inputBindings.get(controlEl);
		const optionValue = binding?.spec.options.debounce;
		return typeof optionValue === 'number' && Number.isFinite(optionValue) && optionValue >= 0 ? optionValue : 250;
	}

	private getControlValue(controlEl: CRControlElement): string {
		if (this.isSelectElement(controlEl)) return controlEl.value;
		return controlEl.value;
	}

	private setControlValue(controlEl: CRControlElement, value: string) {
		if (this.isSelectElement(controlEl)) {
			controlEl.value = value;
			return;
		}
		controlEl.value = value;
	}

	private applyControlResolutionError(controlEl: CRControlElement, message: string) {
		if (this.isInputElement(controlEl)) {
			controlEl.type = 'text';
			controlEl.readOnly = true;
			controlEl.value = `Error: ${message}`;
			this.clearNumberStepperControls(controlEl);
			return;
		}
		if (this.isTextAreaElement(controlEl)) {
			controlEl.readOnly = true;
			controlEl.value = `Error: ${message}`;
			return;
		}
		controlEl.disabled = true;
		controlEl.innerHTML = '';
		const optionEl = document.createElement('option');
		optionEl.value = '';
		optionEl.textContent = `Error: ${message}`;
		controlEl.appendChild(optionEl);
	}

	private async commitInputValue(controlEl: CRControlElement, overrideValue?: string | number | boolean) {
		const binding = this.inputBindings.get(controlEl);
		if (!binding) return;

		const resolved = this.resolveInputBinding(binding);
		if (!resolved.ok) return;

		const valueType = resolved.valueType;
		let newValue: string | number | boolean;
		if (valueType === 'boolean') {
			newValue = typeof overrideValue === 'boolean'
				? overrideValue
				: (this.isInputElement(controlEl) ? controlEl.checked : false);
		} else if (valueType === 'number') {
			if (typeof overrideValue === 'number' && Number.isFinite(overrideValue)) {
				newValue = this.clampNumberValue(overrideValue, this.getNumberConstraints(controlEl));
			} else {
				const parsed = Number(this.getControlValue(controlEl));
				if (!Number.isFinite(parsed)) {
					this.scheduleSyncForInput(controlEl, { immediate: false, delayed: true });
					return;
				}
				newValue = this.clampNumberValue(parsed, this.getNumberConstraints(controlEl));
			}
			this.setControlValue(controlEl, String(newValue));
			this.updateNumberStepperDisabledState(controlEl, newValue);
		} else {
			if (this.isInputElement(controlEl) && controlEl.dataset.crDisplayType === 'calendar') {
				const format = this.getCalendarFormat(resolved.options);
				const formatted = this.fromCalendarInputValue(typeof overrideValue === 'string' ? overrideValue : this.getControlValue(controlEl), format);
				if (formatted === null) {
					this.scheduleSyncForInput(controlEl, { immediate: false, delayed: true });
					return;
				}
				newValue = formatted;
			} else {
				newValue = typeof overrideValue === 'string' ? overrideValue : this.getControlValue(controlEl);
			}
		}

		if (binding.spec.targetKind === 'yaml') {
			const yamlKey = binding.spec.target.slice(5).trim();
			const file = this.app.vault.getAbstractFileByPath(binding.sourcePath);
			if (!(file instanceof TFile)) return;

			await this.app.fileManager.processFrontMatter(file, (fm) => {
				fm[yamlKey] = newValue;
			});
			this.scheduleSyncByPath(binding.sourcePath, { immediate: false, delayed: true });
			this.scheduleDynamicRefresh(binding.sourcePath);
			return;
		}

		const targetVar = this.settings.variables.find((v) => v.name === binding.spec.target);
		if (!targetVar) return;
		if (targetVar.type !== valueType) return;

		targetVar.value = typeof newValue === 'boolean' ? String(newValue) : String(newValue);
		await this.saveSettings({ refreshViews: false, refreshDynamic: true });
		this.syncAllInputs(undefined, { skipActiveControls: true });
	}

	scheduleSyncForInput(controlEl: CRControlElement, mode: { immediate: boolean; delayed: boolean }) {
		if (mode.immediate) {
			this.syncSingleInput(controlEl, undefined, { skipActiveControls: true });
		}
		if (mode.delayed) {
			window.setTimeout(() => this.syncSingleInput(controlEl, undefined, { skipActiveControls: true }), 140);
		}
	}

	scheduleSyncByPath(path: string, mode: { immediate: boolean; delayed: boolean } = { immediate: true, delayed: true }) {
		if (mode.immediate) {
			this.syncAllInputs(path, { skipActiveControls: true });
		}
		if (mode.delayed) {
			window.setTimeout(() => this.syncAllInputs(path, { skipActiveControls: true }), 140);
		}
	}

	syncSingleInput(
		controlEl: CRControlElement,
		changedPath?: string,
		options: { skipActiveControls?: boolean } = {},
	) {
		const binding = this.inputBindings.get(controlEl);
		if (!binding) return;
		if (changedPath && binding.spec.targetKind === 'yaml' && binding.sourcePath !== changedPath) return;

		const state = this.getInputState(controlEl);
		if (options.skipActiveControls) {
			if (state.isEditing || state.isComposing || state.pendingCommitTimer || document.activeElement === controlEl) return;
		}

		const resolved = this.resolveInputBinding(binding);
		if (!resolved.ok) {
			this.applyControlResolutionError(controlEl, resolved.message);
			return;
		}

		const { controlType, valueType, value, options: inputOptions } = resolved;
		this.applyControlOptions(controlEl, controlType, inputOptions, value === undefined || value === null ? '' : String(value));

		if (valueType === 'boolean') {
			if (this.isInputElement(controlEl)) {
				const checked = !!value;
				if (controlEl.checked !== checked) controlEl.checked = checked;
			}
			return;
		}

		const nextValue = value === undefined || value === null ? '' : String(value);
		if (this.isSelectElement(controlEl)) {
			if (controlEl.value !== nextValue) controlEl.value = nextValue;
			return;
		}

		if (this.isInputElement(controlEl) && controlEl.dataset.crDisplayType === 'calendar') {
			const calendarValue = this.toCalendarInputValue(nextValue, this.getCalendarFormat(inputOptions));
			if (controlEl.value !== calendarValue) controlEl.value = calendarValue;
			return;
		}

		if (this.getControlValue(controlEl) !== nextValue) this.setControlValue(controlEl, nextValue);
		if (valueType === 'number') {
			const numericValue = nextValue === '' ? null : Number(nextValue);
			this.updateNumberStepperDisabledState(controlEl, Number.isFinite(numericValue as number) ? (numericValue as number) : null);
		}
	}

	private applySelectOptions(controlEl: HTMLSelectElement, options: Record<string, CRInputOptionValue>, currentValue: string) {
		const normalized = this.normalizeSelectOptions(options.options) ?? [];
		const placeholder = typeof options.placeholder === 'string' ? options.placeholder : '';
		const values = [...normalized];
		if (currentValue && !values.includes(currentValue)) {
			values.unshift(currentValue);
		}

		const signature = JSON.stringify({ values, placeholder, currentValue });
		if (controlEl.dataset.crOptionsSignature === signature) {
			controlEl.value = currentValue;
			return;
		}

		controlEl.innerHTML = '';
		if (placeholder) {
			const placeholderOption = document.createElement('option');
			placeholderOption.value = '';
			placeholderOption.textContent = placeholder;
			controlEl.appendChild(placeholderOption);
		}
		for (const optionValue of values) {
			const optionEl = document.createElement('option');
			optionEl.value = optionValue;
			optionEl.textContent = optionValue;
			controlEl.appendChild(optionEl);
		}
		controlEl.dataset.crOptionsSignature = signature;
		controlEl.value = currentValue;
	}

	private applyControlOptions(
		controlEl: CRControlElement,
		controlType: CRInputControlType,
		options: Record<string, CRInputOptionValue>,
		currentValue: string,
	) {
		const placeholder = typeof options.placeholder === 'string' ? options.placeholder : '';

		if (this.isInputElement(controlEl)) {
			controlEl.disabled = false;
			controlEl.readOnly = false;
			controlEl.placeholder = placeholder;
			controlEl.style.minHeight = '';
			controlEl.style.resize = '';
			controlEl.style.verticalAlign = '';
			if (controlType === 'number') {
				controlEl.type = 'text';
				controlEl.dataset.crDisplayType = 'number';
				controlEl.readOnly = true;
				controlEl.removeAttribute('min');
				controlEl.removeAttribute('max');
				controlEl.removeAttribute('step');
				controlEl.removeAttribute('inputmode');
				controlEl.style.width = '72px';
				controlEl.style.textAlign = 'center';
				this.ensureNumberStepperControls(controlEl);
				return;
			}
			delete controlEl.dataset.crDisplayType;
			this.clearNumberStepperControls(controlEl);
			if (controlType === 'boolean') {
				controlEl.type = 'checkbox';
				controlEl.style.width = '';
				controlEl.style.textAlign = '';
				return;
			}
			if (controlType === 'calendar') {
				controlEl.type = 'date';
				controlEl.dataset.crDisplayType = 'calendar';
				controlEl.style.width = '150px';
				controlEl.style.textAlign = '';
				return;
			}
			controlEl.type = 'text';
			controlEl.style.width = '120px';
			controlEl.style.textAlign = '';
			return;
		}

		if (this.isTextAreaElement(controlEl)) {
			controlEl.disabled = false;
			controlEl.readOnly = false;
			controlEl.placeholder = placeholder;
			const rows = typeof options.rows === 'number' && Number.isFinite(options.rows) && options.rows > 0 ? Math.floor(options.rows) : 3;
			controlEl.rows = rows;
			controlEl.style.width = '240px';
			controlEl.style.minHeight = `${rows * 1.8}em`;
			controlEl.style.resize = 'vertical';
			controlEl.style.verticalAlign = 'top';
			return;
		}

		controlEl.disabled = false;
		controlEl.style.width = '160px';
		controlEl.style.textAlign = '';
		this.applySelectOptions(controlEl, options, currentValue);
	}

	syncAllInputs(changedPath?: string, options: { skipActiveControls?: boolean } = {}) {
		const controls = document.querySelectorAll<HTMLElement>('[data-cr-control="true"]');
		controls.forEach((controlEl) => this.syncSingleInput(controlEl as CRControlElement, changedPath, options));
	}

	private requestDebouncedRefresh(sourcePath?: string) {
		if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.refreshActiveViewsPreserveScroll(sourcePath);
		}, 120);
	}

	private refreshActiveViewsPreserveScroll(sourcePath?: string) {
		this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;
			const filePath = leaf.view.file?.path;
			if (sourcePath && filePath !== sourcePath) return;

			const previewEl = leaf.view.containerEl.querySelector<HTMLElement>('.markdown-preview-view');
			const scrollTop = previewEl?.scrollTop ?? null;
			leaf.view.previewMode.rerender(false);
			if (previewEl && scrollTop !== null) {
				window.requestAnimationFrame(() => {
					previewEl.scrollTop = scrollTop;
					window.setTimeout(() => {
						previewEl.scrollTop = scrollTop;
					}, 60);
				});
			}
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(options: { refreshViews?: boolean; refreshDynamic?: boolean; changedPath?: string } = {}) {
		await this.saveData(this.settings);
		this.syncAllInputs(undefined, { skipActiveControls: true });
		if (options.refreshDynamic !== false) {
			this.scheduleDynamicRefresh(options.changedPath);
		}
		if (options.refreshViews) this.requestDebouncedRefresh(options.changedPath);
	}

	buildContext(): Record<string, unknown> {
		const ctx: Record<string, unknown> = {};
		for (const variable of this.settings.variables) {
			if (variable.type === 'number') ctx[variable.name] = Number(variable.value);
			else if (variable.type === 'boolean') ctx[variable.name] = variable.value === 'true';
			else ctx[variable.name] = variable.value;
		}
		return ctx;
	}

	getFrontmatter(sourcePath: string): Record<string, unknown> {
		if (!sourcePath) return {};
		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (file instanceof TFile) {
			return this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
		}
		return {};
	}

	evaluateExpression(expression: string, sourcePath: string): unknown {
		const context = this.buildContext();
		const keys = Object.keys(context);
		const values = Object.values(context);
		const frontmatter = this.getFrontmatter(sourcePath);
		const cacheKey = `${keys.join('')}${expression}`;

		let compiled = this.expressionFnCache.get(cacheKey);
		if (compiled === undefined) {
			try {
				compiled = new Function(...keys, `return ${expression}`);
			} catch {
				compiled = null;
			}
			this.expressionFnCache.set(cacheKey, compiled);
		}
		if (!compiled) return undefined;

		try {
			return compiled.apply(frontmatter, values);
		} catch {
			return undefined;
		}
	}

	replaceVariables(text: string, sourcePath: string): string {
		return text.replace(/\{\{\s*(.*?)\s*\}\}/g, (match, expression) => {
			const value = this.evaluateExpression(expression, sourcePath);
			return value !== undefined ? String(value) : match;
		});
	}
}

class CRSettingTab extends PluginSettingTab {
	plugin: ConditionalRenderPlugin;
	showShortNames = false;
	importExportText = '';

	constructor(app: App, plugin: ConditionalRenderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl('h2', { text: t('settings_title').replace('0.12.0', '0.15.1') });

		new Setting(containerEl)
			.setName(t('plugin_identifier_name'))
			.setDesc(t('plugin_identifier_desc'))
			.addText((text) => {
				text.setValue(this.plugin.settings.identifier).onChange(async (value) => {
					const val = value.trim() || 'cr';
					if (!isValidIdentifier(val)) {
						text.inputEl.parentElement?.addClass('cr-error-input');
						return;
					}
					text.inputEl.parentElement?.removeClass('cr-error-input');
					this.plugin.settings.identifier = val;
					await this.plugin.saveSettings({ refreshViews: true, refreshDynamic: true });
				});
			});

		new Setting(containerEl)
			.setName(t('hidden_style_name'))
			.setDesc(t('hidden_style_desc'))
			.addDropdown((drop) => {
				drop.selectEl.style.width = '200px';
				drop
					.addOption('none', t('hidden_style_opt_none'))
					.addOption('text', t('hidden_style_opt_text'))
					.addOption('text-grey', t('hidden_style_opt_text_grey'))
					.addOption('underline', t('hidden_style_opt_underline'))
					.addOption('blank', t('hidden_style_opt_blank'))
					.addOption('spoiler', t('hidden_style_opt_spoiler'))
					.addOption('spoiler-round', t('hidden_style_opt_spoiler_round'))
					.addOption('spoiler-white', t('hidden_style_opt_spoiler_white'))
					.addOption('spoiler-white-round', t('hidden_style_opt_spoiler_white_round'))
					.setValue(this.plugin.settings.hiddenStyle)
					.onChange(async (value: CRHiddenStyle) => {
						this.plugin.settings.hiddenStyle = value;
						await this.plugin.saveSettings({ refreshViews: true, refreshDynamic: true });
						this.display();
					});
			});

		if (this.plugin.settings.hiddenStyle === 'text' || this.plugin.settings.hiddenStyle === 'text-grey') {
			new Setting(containerEl)
				.setName(t('custom_text_name'))
				.setDesc(t('custom_text_desc'))
				.addTextArea((text) => {
					text.setValue(this.plugin.settings.hiddenCustomText).onChange(async (value) => {
						this.plugin.settings.hiddenCustomText = value;
						await this.plugin.saveSettings({ refreshViews: true, refreshDynamic: true });
					});
					text.inputEl.style.width = '100%';
					text.inputEl.style.minHeight = '80px';
					text.inputEl.style.resize = 'vertical';
				});
		}

		const legendHeader = new Setting(containerEl)
			.setName(t('legend_header_name'))
			.setDesc(t('legend_header_desc'));

		legendHeader.addButton((btn) =>
			btn.setButtonText(this.showShortNames ? t('btn_show_full') : t('btn_show_short')).onClick(() => {
				this.showShortNames = !this.showShortNames;
				this.display();
			}),
		);

		const id = this.plugin.settings.identifier;
		const getName = (full: string, short: string) => (this.showShortNames ? `${id}-${short}` : `${id}-${full}`);
		const exText = t('legend_example_text');
		const exInput = t('legend_custom_input');

		const legendEl = containerEl.createDiv({ cls: 'cr-style-legend' });
		legendEl.innerHTML = `
			<div class="cr-legend-item"><code>${getName('none', 'n')}</code></div>
			<div class="cr-legend-item"><code>${getName('underline', 'u')}</code> <span class="cr-hidden-underline" title="${exText}">${exText}</span></div>
			<div class="cr-legend-item"><code>${getName('spoiler-white', 'spw')}</code> <span class="cr-hidden-spoiler-white" title="${exText}">${exText}</span></div>
			<div class="cr-legend-item"><code>${getName('text', 't')}</code> <span class="cr-hidden-text">${exInput}</span></div>
			<div class="cr-legend-item"><code>${getName('text-grey', 'tg')}</code> <span class="cr-hidden-text-grey">${exInput}</span></div>
			<div class="cr-legend-item"><code>${getName('spoiler-white-round', 'spwr')}</code> <span class="cr-hidden-spoiler-white-round" title="${exText}">${exText}</span></div>
			<div class="cr-legend-item"><code>${getName('blank', 'b')}</code> <span class="cr-hidden-blank" title="${exText}">${exText}</span></div>
			<div class="cr-legend-item"><code>${getName('spoiler', 'sp')}</code> <span class="cr-hidden-spoiler" title="${exText}">${exText}</span></div>
			<div class="cr-legend-item"><code>${getName('spoiler-round', 'spr')}</code> <span class="cr-hidden-spoiler-round" title="${exText}">${exText}</span></div>
		`;

		const variablesHeader = new Setting(containerEl)
			.setName(t('variables_header_name'))
			.setDesc(t('variables_header_desc'));

		variablesHeader.addButton((button) =>
			button.setButtonText(t('btn_add_variable')).setCta().onClick(async () => {
				this.plugin.settings.variables.push({
					name: `var_${this.plugin.settings.variables.length + 1}`,
					type: 'string',
					value: '',
				});
				await this.plugin.saveSettings({ refreshDynamic: true });
				this.display();
			}),
		);

		this.plugin.settings.variables.forEach((variable, index) => {
			const variableRow = new Setting(containerEl);
			variableRow.settingEl.addClass('cr-setting-row');

			variableRow.settingEl.addEventListener('dragstart', (event) => {
				event.dataTransfer?.setData('text/plain', String(index));
			});
			variableRow.settingEl.addEventListener('dragover', (event) => {
				event.preventDefault();
				variableRow.settingEl.addClass('cr-drag-over');
			});
			variableRow.settingEl.addEventListener('dragleave', () => variableRow.settingEl.removeClass('cr-drag-over'));
			variableRow.settingEl.addEventListener('drop', async (event) => {
				event.preventDefault();
				variableRow.settingEl.removeClass('cr-drag-over');
				const draggedIndex = Number(event.dataTransfer?.getData('text/plain') ?? '-1');
				if (draggedIndex < 0 || draggedIndex === index) return;
				const [item] = this.plugin.settings.variables.splice(draggedIndex, 1);
				this.plugin.settings.variables.splice(index, 0, item);
				await this.plugin.saveSettings({ refreshDynamic: true });
				this.display();
			});
			variableRow.settingEl.addEventListener('dragend', () => {
				variableRow.settingEl.draggable = false;
			});

			const dragHandle = createSpan({ cls: 'cr-drag-handle' });
			setIcon(dragHandle, 'grip-horizontal');
			variableRow.controlEl.appendChild(dragHandle);
			dragHandle.addEventListener('mousedown', () => {
				variableRow.settingEl.draggable = true;
			});
			dragHandle.addEventListener('mouseup', () => {
				variableRow.settingEl.draggable = false;
			});

			variableRow.addText((text) => {
				text.setPlaceholder(t('placeholder_name')).setValue(variable.name).onChange(async (value) => {
					const trimmed = value.trim();
					const duplicated = this.plugin.settings.variables.some((v, i) => i !== index && v.name === trimmed);
					if (!isValidVarName(trimmed) || duplicated) {
						text.inputEl.parentElement?.addClass('cr-error-input');
						return;
					}
					text.inputEl.parentElement?.removeClass('cr-error-input');
					variable.name = trimmed;
					await this.plugin.saveSettings({ refreshDynamic: true });
				});
			});

			variableRow.addDropdown((drop) => {
				drop.selectEl.style.width = '85px';
				drop
					.addOption('string', t('type_string'))
					.addOption('number', t('type_number'))
					.addOption('boolean', t('type_boolean'))
					.setValue(variable.type)
					.onChange(async (value: 'string' | 'number' | 'boolean') => {
						variable.type = value;
						if (value === 'boolean') variable.value = 'true';
						else if (value === 'number') variable.value = '0';
						else variable.value = '';
						await this.plugin.saveSettings({ refreshDynamic: true });
						this.display();
					});
			});

			const valueWrapper = createDiv({ cls: 'cr-input-value' });
			variableRow.controlEl.appendChild(valueWrapper);
			if (variable.type === 'boolean') {
				new ToggleComponent(valueWrapper).setValue(variable.value === 'true').onChange(async (value) => {
					variable.value = String(value);
					await this.plugin.saveSettings({ refreshDynamic: true });
				});
			} else {
				new TextComponent(valueWrapper).setPlaceholder(t('placeholder_value')).setValue(variable.value).onChange(async (value) => {
					variable.value = value;
					await this.plugin.saveSettings({ refreshDynamic: true });
				});
			}

			const spacer = createDiv({ cls: 'cr-spacer' });
			variableRow.controlEl.appendChild(spacer);
			const isDefault = variable.name === this.plugin.getDefaultVariable();
			if (isDefault) {
				const badge = createSpan({ text: t('badge_default'), cls: 'cr-default-badge' });
				variableRow.controlEl.appendChild(badge);
			} else {
				variableRow.addExtraButton((button) =>
					button.setIcon('star').setTooltip(t('tooltip_set_default')).onClick(async () => {
						this.plugin.settings.defaultVariable = variable.name;
						await this.plugin.saveSettings({ refreshDynamic: true });
						this.display();
					}),
				);
			}

			variableRow.addExtraButton((button) =>
				button.setIcon('trash').setTooltip(t('tooltip_delete')).onClick(async () => {
					this.plugin.settings.variables.splice(index, 1);
					if (this.plugin.settings.defaultVariable === variable.name) {
						this.plugin.settings.defaultVariable = this.plugin.settings.variables[0]?.name ?? '';
					}
					await this.plugin.saveSettings({ refreshDynamic: true });
					this.display();
				}),
			);
		});

		containerEl.createEl('hr');
		new Setting(containerEl).setName(t('import_export_name')).setDesc(t('import_export_desc'));

		const ioContainer = containerEl.createDiv();
		const ioTextArea = new TextAreaComponent(ioContainer);
		ioTextArea.inputEl.style.width = '100%';
		ioTextArea.inputEl.style.minHeight = '100px';
		ioTextArea.inputEl.style.fontFamily = 'monospace';
		ioTextArea.setPlaceholder('JSON data will appear here...');
		ioTextArea.onChange((value) => {
			this.importExportText = value;
		});

		const btnContainer = containerEl.createDiv({
			style: 'display: flex; gap: 10px; margin-top: 10px; margin-bottom: 30px;',
		});

		btnContainer.createEl('button', { text: t('btn_export') }).addEventListener('click', () => {
			const json = JSON.stringify(this.plugin.settings.variables, null, 2);
			ioTextArea.setValue(json);
			this.importExportText = json;
		});

		btnContainer.createEl('button', { text: t('btn_import'), cls: 'mod-cta' }).addEventListener('click', async () => {
			try {
				const parsed = JSON.parse(this.importExportText);
				if (!Array.isArray(parsed)) throw new Error('Not an array');
				if (!parsed.every((item) => item && typeof item.name === 'string' && typeof item.type === 'string' && 'value' in item)) {
					throw new Error('Invalid shape');
				}
				this.plugin.settings.variables = parsed;
				await this.plugin.saveSettings({ refreshDynamic: true });
				new Notice(t('import_success'));
				this.display();
			} catch {
				new Notice(t('import_fail'));
			}
		});
	}
}
