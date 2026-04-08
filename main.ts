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
	| 'underline'
	| 'blank'
	| 'spoiler'
	| 'spoiler-white'
	| 'spoiler-round'
	| 'spoiler-white-round';

type CRInputValueType = 'string' | 'number' | 'boolean';
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
	explicitType?: CRInputValueType;
	options: Record<string, string | number | boolean>;
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
	u: 'underline',
	b: 'blank',
	sp: 'spoiler',
	spw: 'spoiler-white',
	spr: 'spoiler-round',
	spwr: 'spoiler-white-round',
};

const INPUT_TYPE_ALIASES: Record<string, CRInputValueType> = {
	bool: 'boolean',
	boolean: 'boolean',
	string: 'string',
	number: 'number',
};

const isValidVarName = (name: string) => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name);
const isValidIdentifier = (name: string) => /^[a-zA-Z0-9_-]+$/.test(name);
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

class CRInputChild extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private readonly inputEl: HTMLInputElement,
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
	private readonly inputBindings = new WeakMap<HTMLInputElement, InputBinding>();
	private readonly inputStates = new WeakMap<HTMLInputElement, InputState>();
	private refreshTimer: number | null = null;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new CRSettingTab(this.app, this));
		console.log(t('log_loaded').replace('0.12.0', '0.14.0'));

		this.registerProcessors();

		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				this.scheduleSyncByPath(file.path);
			}),
		);

		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					this.scheduleSyncByPath(file.path);
				}
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
		const styles: CRHiddenStyle[] = [
			'none',
			'text',
			'text-grey',
			'text-gray',
			'underline',
			'blank',
			'spoiler',
			'spoiler-white',
			'spoiler-round',
			'spoiler-white-round',
		];

		this.registerCodeBlock(id, null);
		styles.forEach((style) => this.registerCodeBlock(`${id}-${style}`, style));
		Object.entries(SHORT_NAME_MAP).forEach(([short, full]) => this.registerCodeBlock(`${id}-${short}`, full));

		this.registerMarkdownPostProcessor((element, context) => {
			const codeBlocks = Array.from(element.querySelectorAll('code'));

			for (const code of codeBlocks) {
				if (code.parentElement?.tagName === 'PRE') continue;
				const text = code.innerText.trim();
				if (!text) continue;

				if (this.tryRenderInteractiveInput(code as HTMLElement, text, context)) {
					continue;
				}

				const regex = new RegExp(`^${escapeRegex(id)}(?:-([a-z-]+))?(:)?\\s*([\\s\\S]*)$`);
				const match = text.match(regex);
				if (!match) continue;

				const inlineStyle = match[1];
				const hasColon = !!match[2];
				const expressionRaw = match[3].trim();

				let activeStyle = this.settings.hiddenStyle;
				if (inlineStyle) {
					if (styles.includes(inlineStyle as CRHiddenStyle)) {
						activeStyle = inlineStyle as CRHiddenStyle;
					} else if (SHORT_NAME_MAP[inlineStyle]) {
						activeStyle = SHORT_NAME_MAP[inlineStyle];
					}
				}

				if (hasColon) {
					const result = this.evaluateExpression(expressionRaw, context.sourcePath);
					code.replaceWith(result !== undefined ? String(result) : `[Error: ${expressionRaw}]`);
					continue;
				}

				let content = this.replaceVariables(expressionRaw, context.sourcePath);
				const evalResult = this.evaluateExpression(content, context.sourcePath);
				if (evalResult !== undefined) {
					content = String(evalResult);
				} else {
					const strMatch = content.match(/^["']([\s\S]*)["']$/);
					if (strMatch) content = strMatch[1];
				}

				const defaultVar = this.getDefaultVariable();
				const isTrue = !!this.evaluateExpression(defaultVar, context.sourcePath);
				if (isTrue) {
					code.replaceWith(content);
				} else {
					this.renderHiddenInline(code as HTMLElement, activeStyle, content, context.sourcePath);
				}
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

			const isTrue = this.evaluateExpression(condition, ctx.sourcePath);
			let activeStyle = this.settings.hiddenStyle;
			if (overrideStyle) activeStyle = SHORT_NAME_MAP[overrideStyle] || overrideStyle;

			let targetContent = '';
			let shouldRenderHidden = false;
			if (isTrue) {
				targetContent = trueContent.join('\n');
			} else if (hasElse) {
				targetContent = falseContent.join('\n');
			} else {
				shouldRenderHidden = true;
				targetContent = trueContent.join('\n');
			}

			targetContent = this.replaceVariables(targetContent, ctx.sourcePath);
			if (!targetContent.trim()) return;

			if (shouldRenderHidden) {
				this.renderHiddenBlock(el, activeStyle, targetContent, ctx.sourcePath);
			} else {
				MarkdownRenderer.renderMarkdown(targetContent, el, ctx.sourcePath, this);
			}
		});
	}

	renderHiddenInline(codeEl: HTMLElement, style: CRHiddenStyle, originalText: string, sourcePath: string) {
		if (style === 'none') {
			codeEl.replaceWith('');
			return;
		}

		const span = document.createElement('span');
		span.title = originalText;

		if (style === 'text' || style === 'text-grey' || style === 'text-gray') {
			span.className = style === 'text' ? 'cr-hidden-text' : 'cr-hidden-text-grey';
			MarkdownRenderer.renderMarkdown(this.settings.hiddenCustomText, span, sourcePath, this).then(() => {
				const p = span.querySelector('p');
				if (p) span.innerHTML = p.innerHTML;
			});
		} else {
			span.textContent = originalText;
			span.className = `cr-hidden-${style}`;
		}

		codeEl.replaceWith(span);
	}

	renderHiddenBlock(containerEl: HTMLElement, style: CRHiddenStyle, originalMarkdown: string, sourcePath: string) {
		if (style === 'none') return;
		const wrapper = containerEl.createDiv();

		if (style === 'text' || style === 'text-grey' || style === 'text-gray') {
			wrapper.className = style === 'text' ? 'cr-block-text' : 'cr-block-text-grey';
			MarkdownRenderer.renderMarkdown(this.settings.hiddenCustomText, wrapper, sourcePath, this);
			return;
		}

		wrapper.className = `cr-block-${style}`;
		MarkdownRenderer.renderMarkdown(originalMarkdown, wrapper, sourcePath, this);
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
				message: 'Invalid typed syntax. Use cr-input: bool(name) / string(name) / number(this.score)',
			};
		}

		const rawType = typedMatch[1].toLowerCase();
		const explicitType = INPUT_TYPE_ALIASES[rawType];
		if (!explicitType) {
			return {
				ok: false,
				message: `Unsupported input type "${rawType}". Allowed: bool, string, number`,
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

		const options: Record<string, string | number | boolean> = {};
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

		return {
			ok: true,
			value: {
				mode,
				raw,
				target,
				targetKind,
				explicitType,
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

	private parseOptionValue(raw: string): string | number | boolean {
		const trimmed = raw.trim();
		if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
		if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
		const quoted = trimmed.match(/^(["'])([\s\S]*)\1$/);
		if (quoted) return quoted[2];
		return trimmed;
	}

	private resolveInputBinding(binding: InputBinding):
		| { ok: true; valueType: CRInputValueType; value: unknown; options: ParsedInputSpec['options'] }
		| { ok: false; message: string } {
		const { spec, sourcePath } = binding;

		if (spec.targetKind === 'global') {
			const globalVar = this.settings.variables.find((v) => v.name === spec.target);
			if (!globalVar) {
				return { ok: false, message: `Global variable "${spec.target}" not found in settings` };
			}

			if (spec.explicitType && spec.explicitType !== globalVar.type) {
				return {
					ok: false,
					message: `Type mismatch for global variable "${spec.target}": settings=${globalVar.type}, input=${spec.explicitType}`,
				};
			}

			const valueType = spec.explicitType ?? globalVar.type;
			let value: unknown = globalVar.value;
			if (valueType === 'boolean') value = globalVar.value === 'true';
			else if (valueType === 'number') value = globalVar.value === '' ? '' : Number(globalVar.value);

			return { ok: true, valueType, value, options: spec.options };
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
		const valueType = spec.explicitType ?? inferredType;

		let value: unknown = currentValue;
		if (value === undefined || value === null) {
			value = valueType === 'boolean' ? false : '';
		}
		if (valueType === 'number' && typeof value === 'number' && !Number.isFinite(value)) value = '';
		if (valueType === 'number' && typeof value === 'string') value = value.trim();
		if (valueType === 'boolean' && typeof value !== 'boolean') value = value === true;

		return { ok: true, valueType, value, options: spec.options };
	}

	private renderInteractiveInput(codeEl: HTMLElement, spec: ParsedInputSpec, context: MarkdownPostProcessorContext) {
		const wrapper = document.createElement('span');
		const inputEl = document.createElement('input');
		inputEl.className = 'cr-interactive-input';
		wrapper.appendChild(inputEl);
		codeEl.replaceWith(wrapper);

		const binding: InputBinding = {
			sourcePath: context.sourcePath,
			spec,
		};
		this.inputBindings.set(inputEl, binding);
		this.inputStates.set(inputEl, { isEditing: false, isComposing: false, pendingCommitTimer: null });

		this.setupInputListeners(inputEl);
		context.addChild(new CRInputChild(wrapper, inputEl, this));
		this.scheduleSyncForInput(inputEl, { immediate: true, delayed: true });
	}

	private setupInputListeners(inputEl: HTMLInputElement) {
		inputEl.addEventListener('focus', () => {
			const state = this.getInputState(inputEl);
			state.isEditing = true;
		});

		inputEl.addEventListener('blur', () => {
			const state = this.getInputState(inputEl);
			this.flushPendingCommit(inputEl);
			state.isEditing = false;
			state.isComposing = false;
			this.scheduleSyncForInput(inputEl, { immediate: false, delayed: true });
		});

		inputEl.addEventListener('compositionstart', () => {
			const state = this.getInputState(inputEl);
			state.isEditing = true;
			state.isComposing = true;
		});

		inputEl.addEventListener('compositionend', () => {
			const state = this.getInputState(inputEl);
			state.isComposing = false;
			if (inputEl.type !== 'checkbox') {
				this.scheduleCommit(inputEl);
			}
		});

		inputEl.addEventListener('input', () => {
			if (inputEl.type === 'checkbox') return;
			this.scheduleCommit(inputEl);
		});

		inputEl.addEventListener('change', () => {
			if (inputEl.type === 'checkbox') {
				void this.commitInputValue(inputEl);
			} else {
				this.scheduleCommit(inputEl);
			}
		});

		inputEl.addEventListener('keydown', (event) => {
			event.stopPropagation();
			if (event.key === 'Enter' && inputEl.type !== 'checkbox') {
				inputEl.blur();
			}
		});
		inputEl.addEventListener('click', (event) => event.stopPropagation());
	}

	private getInputState(inputEl: HTMLInputElement): InputState {
		let state = this.inputStates.get(inputEl);
		if (!state) {
			state = { isEditing: false, isComposing: false, pendingCommitTimer: null };
			this.inputStates.set(inputEl, state);
		}
		return state;
	}

	private isTextLikeInput(inputEl: HTMLInputElement) {
		return inputEl.type === 'text' || inputEl.type === 'number';
	}

	private scheduleCommit(inputEl: HTMLInputElement) {
		const state = this.getInputState(inputEl);
		if (state.isComposing) return;
		if (state.pendingCommitTimer) window.clearTimeout(state.pendingCommitTimer);

		const debounce = this.getInputDebounce(inputEl);
		state.pendingCommitTimer = window.setTimeout(() => {
			state.pendingCommitTimer = null;
			void this.commitInputValue(inputEl);
		}, debounce);
	}

	private flushPendingCommit(inputEl: HTMLInputElement) {
		const state = this.getInputState(inputEl);
		if (state.pendingCommitTimer) {
			window.clearTimeout(state.pendingCommitTimer);
			state.pendingCommitTimer = null;
			void this.commitInputValue(inputEl);
		}
	}

	private getInputDebounce(inputEl: HTMLInputElement): number {
		const binding = this.inputBindings.get(inputEl);
		const optionValue = binding?.spec.options.debounce;
		return typeof optionValue === 'number' && Number.isFinite(optionValue) && optionValue >= 0 ? optionValue : 250;
	}

	private async commitInputValue(inputEl: HTMLInputElement) {
		const binding = this.inputBindings.get(inputEl);
		if (!binding) return;

		const resolved = this.resolveInputBinding(binding);
		if (!resolved.ok) return;

		const valueType = resolved.valueType;
		let newValue: string | number | boolean;
		if (valueType === 'boolean') {
			newValue = inputEl.checked;
		} else if (valueType === 'number') {
			const raw = inputEl.value.trim();
			if (raw === '') {
				newValue = '';
			} else {
				const parsed = Number(raw);
				if (Number.isNaN(parsed)) return;
				newValue = parsed;
			}
		} else {
			newValue = inputEl.value;
		}

		if (binding.spec.targetKind === 'yaml') {
			const yamlKey = binding.spec.target.slice(5).trim();
			const file = this.app.vault.getAbstractFileByPath(binding.sourcePath);
			if (!(file instanceof TFile)) return;

			await this.app.fileManager.processFrontMatter(file, (fm) => {
				fm[yamlKey] = newValue;
			});
			this.scheduleSyncByPath(binding.sourcePath);
			return;
		}

		const targetVar = this.settings.variables.find((v) => v.name === binding.spec.target);
		if (!targetVar) return;
		if (targetVar.type !== valueType) return;

		targetVar.value = typeof newValue === 'boolean' ? String(newValue) : String(newValue);
		await this.saveSettings({ refreshViews: false });
		this.syncAllInputs(undefined, { skipActiveTextInputs: true });
	}

	scheduleSyncForInput(inputEl: HTMLInputElement, mode: { immediate: boolean; delayed: boolean }) {
		if (mode.immediate) {
			this.syncSingleInput(inputEl, undefined, { skipActiveTextInputs: true });
		}
		if (mode.delayed) {
			window.setTimeout(() => this.syncSingleInput(inputEl, undefined, { skipActiveTextInputs: true }), 60);
			window.setTimeout(() => this.syncSingleInput(inputEl, undefined, { skipActiveTextInputs: true }), 220);
			window.setTimeout(() => this.syncSingleInput(inputEl, undefined, { skipActiveTextInputs: true }), 500);
		}
	}

	scheduleSyncByPath(path: string) {
		this.syncAllInputs(path, { skipActiveTextInputs: true });
		window.setTimeout(() => this.syncAllInputs(path, { skipActiveTextInputs: true }), 60);
		window.setTimeout(() => this.syncAllInputs(path, { skipActiveTextInputs: true }), 220);
		window.setTimeout(() => this.syncAllInputs(path, { skipActiveTextInputs: true }), 500);
	}

	syncSingleInput(
		inputEl: HTMLInputElement,
		changedPath?: string,
		options: { skipActiveTextInputs?: boolean } = {},
	) {
		const binding = this.inputBindings.get(inputEl);
		if (!binding) return;
		if (changedPath && binding.spec.targetKind === 'yaml' && binding.sourcePath !== changedPath) return;

		const state = this.getInputState(inputEl);
		if (options.skipActiveTextInputs && this.isTextLikeInput(inputEl)) {
			if (state.isEditing || state.isComposing || state.pendingCommitTimer) return;
		}

		const resolved = this.resolveInputBinding(binding);
		if (!resolved.ok) {
			inputEl.type = 'text';
			if (!options.skipActiveTextInputs || !state.isEditing) {
				inputEl.value = `Error: ${resolved.message}`;
			}
			return;
		}

		const { valueType, value, options: inputOptions } = resolved;
		const desiredType = valueType === 'boolean' ? 'checkbox' : valueType === 'number' ? 'number' : 'text';
		if (inputEl.type !== desiredType) inputEl.type = desiredType;
		this.applyInputOptions(inputEl, valueType, inputOptions);

		if (desiredType === 'checkbox') {
			const checked = !!value;
			if (inputEl.checked !== checked) inputEl.checked = checked;
			return;
		}

		const nextValue = value === undefined || value === null ? '' : String(value);
		if (inputEl.value !== nextValue) inputEl.value = nextValue;
	}

	private applyInputOptions(
		inputEl: HTMLInputElement,
		valueType: CRInputValueType,
		options: Record<string, string | number | boolean>,
	) {
		const placeholder = options.placeholder;
		inputEl.placeholder = typeof placeholder === 'string' ? placeholder : '';

		if (valueType === 'number') {
			inputEl.min = typeof options.min === 'number' ? String(options.min) : '';
			inputEl.max = typeof options.max === 'number' ? String(options.max) : '';
			inputEl.step = typeof options.step === 'number' ? String(options.step) : '';
		} else {
			inputEl.removeAttribute('min');
			inputEl.removeAttribute('max');
			inputEl.removeAttribute('step');
		}
	}

	syncAllInputs(changedPath?: string, options: { skipActiveTextInputs?: boolean } = {}) {
		const inputs = document.querySelectorAll<HTMLInputElement>('.cr-interactive-input');
		inputs.forEach((inputEl) => this.syncSingleInput(inputEl, changedPath, options));
	}

	private requestDebouncedRefresh() {
		if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			this.refreshActiveViewsPreserveScroll();
		}, 250);
	}

	private refreshActiveViewsPreserveScroll() {
		this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
			if (!(leaf.view instanceof MarkdownView)) return;

			const previewEl = leaf.view.containerEl.querySelector<HTMLElement>('.markdown-preview-view');
			const scrollTop = previewEl?.scrollTop ?? null;
			leaf.view.previewMode.rerender(true);
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

	async saveSettings(options: { refreshViews?: boolean } = {}) {
		await this.saveData(this.settings);
		this.syncAllInputs(undefined, { skipActiveTextInputs: true });
		if (options.refreshViews) this.requestDebouncedRefresh();
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

		try {
			const fn = new Function(...keys, `return ${expression}`);
			return fn.apply(frontmatter, values);
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
		containerEl.createEl('h2', { text: t('settings_title').replace('0.12.0', '0.14.0') });

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
					await this.plugin.saveSettings({ refreshViews: true });
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
						await this.plugin.saveSettings({ refreshViews: true });
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
						await this.plugin.saveSettings({ refreshViews: true });
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

		containerEl.createEl('p', {
			text: 'Typed input syntax: cr-input: bool(name) / string(name, placeholder="text") / number(this.score, min=0, max=100, step=1)',
		});
		containerEl.createEl('p', {
			text: 'Legacy input syntax is still supported: cr-input name / cr-input this.status',
		});

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
				await this.plugin.saveSettings();
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
				await this.plugin.saveSettings();
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
					await this.plugin.saveSettings();
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
						await this.plugin.saveSettings();
						this.display();
					});
			});

			const valueWrapper = createDiv({ cls: 'cr-input-value' });
			variableRow.controlEl.appendChild(valueWrapper);
			if (variable.type === 'boolean') {
				new ToggleComponent(valueWrapper).setValue(variable.value === 'true').onChange(async (value) => {
					variable.value = String(value);
					await this.plugin.saveSettings();
				});
			} else {
				new TextComponent(valueWrapper).setPlaceholder(t('placeholder_value')).setValue(variable.value).onChange(async (value) => {
					variable.value = value;
					await this.plugin.saveSettings();
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
						await this.plugin.saveSettings({ refreshViews: true });
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
					await this.plugin.saveSettings({ refreshViews: true });
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
				await this.plugin.saveSettings();
				new Notice(t('import_success'));
				this.display();
			} catch {
				new Notice(t('import_fail'));
			}
		});
	}
}
