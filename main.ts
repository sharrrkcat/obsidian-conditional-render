import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	MarkdownRenderer,
	setIcon,
	MarkdownView,
	ToggleComponent,
	TextComponent,
	TextAreaComponent,
	TFile,
	Notice,
	MarkdownRenderChild,
	MarkdownPostProcessorContext,
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

interface ConditionalRenderSettings {
	identifier: string;
	hiddenStyle: CRHiddenStyle;
	hiddenCustomText: string;
	defaultVariable: string;
	variables: CRVariable[];
}

interface SyncOptions {
	force?: boolean;
}

const PLUGIN_VERSION = '0.13.1';
const INPUT_COMMIT_DELAY = 180;
const FRONTMATTER_SYNC_DELAYS = [0, 60, 220] as const;
const SUPPORTED_STYLES: CRHiddenStyle[] = [
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

const isValidVarName = (name: string) => {
	if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) return false;
	try {
		new Function(`let ${name};`);
		return true;
	} catch {
		return false;
	}
};
const isValidIdentifier = (name: string) => /^[a-zA-Z0-9_-]+$/.test(name);
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function normalizeVariable(candidate: unknown, index: number): CRVariable | null {
	if (!candidate || typeof candidate !== 'object') return null;

	const raw = candidate as Partial<CRVariable>;
	const name = typeof raw.name === 'string' && isValidVarName(raw.name)
		? raw.name
		: `var_${index + 1}`;

	const type: CRVariable['type'] =
		raw.type === 'number' || raw.type === 'boolean' || raw.type === 'string'
			? raw.type
			: 'string';

	let value = raw.value;
	if (type === 'boolean') {
		value = String(value === true || value === 'true');
	} else if (type === 'number') {
		const numeric = Number(value);
		value = Number.isFinite(numeric) ? String(numeric) : '0';
	} else {
		value = value ?? '';
	}

	return {
		name,
		type,
		value: String(value),
	};
}

class CRInputChild extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private readonly inputEl: HTMLInputElement,
		private readonly plugin: ConditionalRenderPlugin,
	) {
		super(containerEl);
	}

	onload() {
		this.plugin.syncSingleInput(this.inputEl, undefined, { force: true });
	}
}

export default class ConditionalRenderPlugin extends Plugin {
	settings: ConditionalRenderSettings;

	private refreshTimer: number | null = null;
	private refreshTargetPath: string | null = null;
	private inputCommitTimers = new WeakMap<HTMLInputElement, number>();
	private pendingFileSyncTimers = new Map<string, number[]>();

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new CRSettingTab(this.app, this));
		console.log(t('log_loaded').replace('0.12.0', PLUGIN_VERSION));

		this.registerProcessors();

		this.registerEvent(
			this.app.metadataCache.on('changed', (file) => {
				this.handleMetadataChanged(file.path);
			}),
		);
	}

	onunload() {
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}

		for (const timers of this.pendingFileSyncTimers.values()) {
			timers.forEach((timerId) => window.clearTimeout(timerId));
		}
		this.pendingFileSyncTimers.clear();

		console.log(t('log_unloaded'));
	}

	private handleMetadataChanged(path: string) {
		this.scheduleInputSync(path);
	}

	private scheduleInputSync(path: string) {
		const existing = this.pendingFileSyncTimers.get(path);
		if (existing) {
			existing.forEach((timerId) => window.clearTimeout(timerId));
		}

		const timers: number[] = [];
		for (const delay of FRONTMATTER_SYNC_DELAYS) {
			let timerId = 0;
			timerId = window.setTimeout(() => {
				this.syncAllInputs(path, { force: true });

				const current = this.pendingFileSyncTimers.get(path);
				if (!current) return;
				const index = current.indexOf(timerId);
				if (index > -1) current.splice(index, 1);
				if (current.length === 0) this.pendingFileSyncTimers.delete(path);
			}, delay);
			timers.push(timerId);
		}

		this.pendingFileSyncTimers.set(path, timers);
	}

	getDefaultVariable(): string {
		const defaultVar = this.settings.defaultVariable;
		if (defaultVar && this.settings.variables.some((variable) => variable.name === defaultVar)) {
			return defaultVar;
		}
		return this.settings.variables.length > 0 ? this.settings.variables[0].name : 'true';
	}

	isDuplicateVarName(name: string, excludeIndex?: number): boolean {
		return this.settings.variables.some((variable, index) => index !== excludeIndex && variable.name === name);
	}

	registerProcessors() {
		const identifier = escapeRegExp(this.settings.identifier);

		this.registerCodeBlock(this.settings.identifier, null);
		SUPPORTED_STYLES.forEach((style) => this.registerCodeBlock(`${this.settings.identifier}-${style}`, style));
		Object.entries(SHORT_NAME_MAP).forEach(([shortName, fullStyle]) => {
			this.registerCodeBlock(`${this.settings.identifier}-${shortName}`, fullStyle);
		});

		this.registerMarkdownPostProcessor((element, context) => {
			const codeBlocks = element.findAll('code');
			const regex = new RegExp(`^${identifier}(?:-([a-z-]+))?(:)?\\s*(.*)$`, 's');

			for (const code of codeBlocks) {
				if (code.parentElement?.tagName === 'PRE') continue;

				const text = code.textContent?.trim() ?? '';
				const match = text.match(regex);
				if (!match) continue;

				const inlineStyle = match[1];
				const hasColon = Boolean(match[2]);
				const expressionRaw = match[3].trim();

				if (inlineStyle === 'input') {
					this.renderInteractiveInput(code, expressionRaw, context.sourcePath, context);
					continue;
				}

				let activeStyle = this.settings.hiddenStyle;
				if (inlineStyle) {
					if (SUPPORTED_STYLES.includes(inlineStyle as CRHiddenStyle)) {
						activeStyle = inlineStyle as CRHiddenStyle;
					} else if (SHORT_NAME_MAP[inlineStyle]) {
						activeStyle = SHORT_NAME_MAP[inlineStyle];
					}
				}

				if (hasColon) {
					const result = this.evaluateExpression(expressionRaw, context.sourcePath);
					code.replaceWith(document.createTextNode(result !== undefined ? String(result) : `[Error: ${expressionRaw}]`));
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
				const isTrue = Boolean(this.evaluateExpression(defaultVar, context.sourcePath));

				if (isTrue) {
					code.replaceWith(document.createTextNode(content));
				} else {
					this.renderHiddenInline(code, activeStyle, content, context.sourcePath);
				}
			}
		});
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
					condition = trimmed.substring(ifPrefix.length).trim();
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

			const isTrue = Boolean(this.evaluateExpression(condition, ctx.sourcePath));
			const activeStyle = overrideStyle ?? this.settings.hiddenStyle;

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
			if (targetContent.trim() === '') return;

			if (shouldRenderHidden) {
				this.renderHiddenBlock(el, activeStyle, targetContent, ctx.sourcePath);
			} else {
				MarkdownRenderer.renderMarkdown(targetContent, el, ctx.sourcePath, this);
			}
		});
	}

	renderHiddenInline(codeEl: HTMLElement, style: CRHiddenStyle, originalText: string, sourcePath: string) {
		if (style === 'none') {
			codeEl.replaceWith(document.createTextNode(''));
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
		containerEl.empty();
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

	renderInteractiveInput(
		codeEl: HTMLElement,
		varName: string,
		sourcePath: string,
		context: MarkdownPostProcessorContext,
	) {
		const cleanVarName = varName.trim();
		const span = document.createElement('span');
		const inputEl = document.createElement('input');
		inputEl.className = 'cr-interactive-input';
		inputEl.dataset.crVar = cleanVarName;
		inputEl.dataset.crSource = sourcePath;
		inputEl.setAttribute('aria-label', cleanVarName);

		span.appendChild(inputEl);
		codeEl.replaceWith(span);

		this.setupInputListeners(inputEl, cleanVarName, sourcePath);

		const child = new CRInputChild(span, inputEl, this);
		context.addChild(child);

		this.syncSingleInput(inputEl, undefined, { force: true });
	}

	private commitInputChange(inputEl: HTMLInputElement, varName: string, sourcePath: string) {
		const isYaml = varName.startsWith('this.');
		const parsed = this.readTypedInputValue(inputEl);
		if (parsed === undefined) return;

		void (async () => {
			if (isYaml) {
				const yamlKey = varName.substring(5).trim();
				const file = this.app.vault.getAbstractFileByPath(sourcePath);
				if (!(file instanceof TFile)) return;

				await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
					frontmatter[yamlKey] = parsed;
				});
				this.requestDebouncedRefresh(sourcePath);
				return;
			}

			const globalVar = this.settings.variables.find((variable) => variable.name === varName);
			if (!globalVar) return;

			globalVar.value = String(parsed);
			await this.saveSettings({ refreshMode: 'debounced' });
		})();
	}

	private scheduleInputCommit(inputEl: HTMLInputElement, varName: string, sourcePath: string) {
		const existingTimer = this.inputCommitTimers.get(inputEl);
		if (existingTimer !== undefined) {
			window.clearTimeout(existingTimer);
		}

		const timer = window.setTimeout(() => {
			this.inputCommitTimers.delete(inputEl);
			this.commitInputChange(inputEl, varName, sourcePath);
		}, INPUT_COMMIT_DELAY);
		this.inputCommitTimers.set(inputEl, timer);
	}

	private flushPendingInputCommit(inputEl: HTMLInputElement, varName: string, sourcePath: string) {
		const existingTimer = this.inputCommitTimers.get(inputEl);
		if (existingTimer !== undefined) {
			window.clearTimeout(existingTimer);
			this.inputCommitTimers.delete(inputEl);
		}
		this.commitInputChange(inputEl, varName, sourcePath);
	}

	setupInputListeners(inputEl: HTMLInputElement, cleanVarName: string, sourcePath: string) {
		inputEl.addEventListener('input', () => {
			if (inputEl.type === 'checkbox') return;
			this.scheduleInputCommit(inputEl, cleanVarName, sourcePath);
		});

		inputEl.addEventListener('change', () => {
			if (inputEl.type === 'checkbox') {
				this.flushPendingInputCommit(inputEl, cleanVarName, sourcePath);
				return;
			}
			this.scheduleInputCommit(inputEl, cleanVarName, sourcePath);
		});

		inputEl.addEventListener('blur', () => {
			this.flushPendingInputCommit(inputEl, cleanVarName, sourcePath);
			this.syncSingleInput(inputEl, undefined, { force: true });
		});

		inputEl.addEventListener('keyup', (event) => {
			if (event.key === 'Enter') inputEl.blur();
		});

		inputEl.addEventListener('click', (event) => event.stopPropagation());
		inputEl.addEventListener('keydown', (event) => event.stopPropagation());
	}

	private readTypedInputValue(inputEl: HTMLInputElement): string | number | boolean | undefined {
		if (inputEl.type === 'checkbox') return inputEl.checked;
		if (inputEl.type === 'number') {
			const trimmed = inputEl.value.trim();
			if (trimmed === '') return undefined;
			const parsed = Number(trimmed);
			return Number.isFinite(parsed) ? parsed : undefined;
		}
		return inputEl.value;
	}

	syncSingleInput(inputEl: HTMLInputElement, changedPath?: string, options: SyncOptions = {}) {
		const varName = inputEl.dataset.crVar;
		const sourcePath = inputEl.dataset.crSource;
		if (!varName) return;

		if (changedPath && varName.startsWith('this.') && sourcePath !== changedPath) {
			return;
		}

		if (!options.force && document.activeElement === inputEl) {
			return;
		}

		let newValue: string | number | boolean | undefined = '';
		let varType: CRVariable['type'] = 'string';

		if (varName.startsWith('this.')) {
			const yamlKey = varName.substring(5).trim();
			const frontmatter = this.getFrontmatter(sourcePath || '');
			newValue = frontmatter[yamlKey];
			if (typeof newValue === 'boolean') varType = 'boolean';
			else if (typeof newValue === 'number') varType = 'number';
			else newValue = newValue !== undefined ? String(newValue) : '';
		} else {
			const globalVar = this.settings.variables.find((variable) => variable.name === varName.trim());
			if (globalVar) {
				varType = globalVar.type;
				if (varType === 'boolean') newValue = globalVar.value === 'true';
				else if (varType === 'number') newValue = Number(globalVar.value);
				else newValue = globalVar.value;
			}
		}

		if (varType === 'boolean' && inputEl.type !== 'checkbox') {
			inputEl.type = 'checkbox';
		} else if (varType === 'number' && inputEl.type !== 'number') {
			inputEl.type = 'number';
		} else if (varType === 'string' && inputEl.type !== 'text') {
			inputEl.type = 'text';
		}

		if (inputEl.type === 'checkbox') {
			const nextValue = Boolean(newValue);
			if (inputEl.checked !== nextValue) inputEl.checked = nextValue;
			return;
		}

		const strVal = newValue !== undefined && newValue !== null ? String(newValue) : '';
		if (inputEl.value !== strVal) inputEl.value = strVal;
	}

	syncAllInputs(changedPath?: string, options: SyncOptions = {}) {
		const inputs = document.querySelectorAll<HTMLInputElement>('.cr-interactive-input');
		inputs.forEach((inputEl) => this.syncSingleInput(inputEl, changedPath, options));
	}

	requestDebouncedRefresh(targetPath?: string) {
		if (targetPath) this.refreshTargetPath = targetPath;
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);

		this.refreshTimer = window.setTimeout(() => {
			const path = this.refreshTargetPath;
			this.refreshTargetPath = null;
			this.refreshTimer = null;

			if (path) this.refreshFileViews(path);
			else this.refreshActiveViews();
		}, 250);
	}

	async loadSettings() {
		const loaded = await this.loadData();
		const loadedVariables = Array.isArray(loaded?.variables)
			? loaded.variables.map((item: unknown, index: number) => normalizeVariable(item, index)).filter(Boolean) as CRVariable[]
			: DEFAULT_SETTINGS.variables;

		this.settings = {
			...DEFAULT_SETTINGS,
			...(loaded ?? {}),
			variables: loadedVariables.length > 0 ? loadedVariables : DEFAULT_SETTINGS.variables,
		};

		if (!isValidIdentifier(this.settings.identifier)) {
			this.settings.identifier = DEFAULT_SETTINGS.identifier;
		}
	}

	async saveSettings(options: { refreshMode?: 'none' | 'immediate' | 'debounced' } = {}) {
		const refreshMode = options.refreshMode ?? 'none';
		await this.saveData(this.settings);
		this.syncAllInputs(undefined, { force: true });

		if (refreshMode === 'immediate') this.refreshActiveViews();
		else if (refreshMode === 'debounced') this.requestDebouncedRefresh();
	}

	refreshActiveViews() {
		this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				this.safeRerenderView(leaf.view);
			}
		});
	}

	private refreshFileViews(path: string) {
		this.app.workspace.getLeavesOfType('markdown').forEach((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) {
				this.safeRerenderView(leaf.view);
			}
		});
	}

	private safeRerenderView(view: MarkdownView) {
		const previewMode = view.previewMode as {
			rerender?: (full?: boolean) => void;
			getScroll?: () => number;
			applyScroll?: (scroll: number) => void;
		};
		const editor = view.editor;
		const editorScroll = typeof editor?.getScrollInfo === 'function' ? editor.getScrollInfo() : null;
		const previewScroll = typeof previewMode.getScroll === 'function' ? previewMode.getScroll() : null;

		previewMode.rerender?.(true);

		window.requestAnimationFrame(() => {
			if (editorScroll && typeof editor?.scrollTo === 'function') {
				editor.scrollTo(editorScroll.left, editorScroll.top);
			}
			if (previewScroll !== null && typeof previewMode.applyScroll === 'function') {
				previewMode.applyScroll(previewScroll);
			}
		});
	}

	buildContext(): Record<string, string | number | boolean> {
		const ctx: Record<string, string | number | boolean> = {};
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
			const fn = new Function(...keys, `"use strict"; return (${expression});`);
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
		containerEl.createEl('h2', { text: t('settings_title').replace('0.12.0', PLUGIN_VERSION) });

		new Setting(containerEl)
			.setName(t('plugin_identifier_name'))
			.setDesc(t('plugin_identifier_desc'))
			.addText((text) => {
				text
					.setValue(this.plugin.settings.identifier)
					.onChange(async (value) => {
						const nextValue = value.trim() || 'cr';
						const invalid = !isValidIdentifier(nextValue);
						text.inputEl.parentElement?.toggleClass('cr-error-input', invalid);
						if (invalid) return;

						this.plugin.settings.identifier = nextValue;
						await this.plugin.saveSettings();
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
						await this.plugin.saveSettings({ refreshMode: 'debounced' });
						this.display();
					});
			});

		if (this.plugin.settings.hiddenStyle === 'text' || this.plugin.settings.hiddenStyle === 'text-grey' || this.plugin.settings.hiddenStyle === 'text-gray') {
			new Setting(containerEl)
				.setName(t('custom_text_name'))
				.setDesc(t('custom_text_desc'))
				.addTextArea((text) => {
					text
						.setValue(this.plugin.settings.hiddenCustomText)
						.onChange(async (value) => {
							this.plugin.settings.hiddenCustomText = value;
							await this.plugin.saveSettings({ refreshMode: 'debounced' });
						});
					text.inputEl.style.width = '100%';
					text.inputEl.style.minHeight = '80px';
					text.inputEl.style.resize = 'vertical';
				});
		}

		const legendHeader = new Setting(containerEl)
			.setName(t('legend_header_name'))
			.setDesc(t('legend_header_desc'));

		legendHeader.addButton((button) =>
			button
				.setButtonText(this.showShortNames ? t('btn_show_full') : t('btn_show_short'))
				.onClick(() => {
					this.showShortNames = !this.showShortNames;
					this.display();
				}),
		);

		const id = this.plugin.settings.identifier;
		const getName = (full: string, short: string) => (this.showShortNames ? `${id}-${short}` : `${id}-${full}`);
		const exampleText = t('legend_example_text');
		const exampleInput = t('legend_custom_input');

		const legendEl = containerEl.createDiv({ cls: 'cr-style-legend' });
		legendEl.innerHTML = `
			<div class="cr-legend-item"><code>${getName('none', 'n')}</code></div>
			<div class="cr-legend-item"><code>${getName('underline', 'u')}</code> <span class="cr-hidden-underline" title="${exampleText}">${exampleText}</span></div>
			<div class="cr-legend-item"><code>${getName('spoiler-white', 'spw')}</code> <span class="cr-hidden-spoiler-white" title="${exampleText}">${exampleText}</span></div>

			<div class="cr-legend-item"><code>${getName('text', 't')}</code> <span class="cr-hidden-text">${exampleInput}</span></div>
			<div class="cr-legend-item"><code>${getName('text-grey', 'tg')}</code> <span class="cr-hidden-text-grey">${exampleInput}</span></div>
			<div class="cr-legend-item"><code>${getName('spoiler-white-round', 'spwr')}</code> <span class="cr-hidden-spoiler-white-round" title="${exampleText}">${exampleText}</span></div>

			<div class="cr-legend-item"><code>${getName('blank', 'b')}</code> <span class="cr-hidden-blank" title="${exampleText}">${exampleText}</span></div>
			<div class="cr-legend-item"><code>${getName('spoiler', 'sp')}</code> <span class="cr-hidden-spoiler" title="${exampleText}">${exampleText}</span></div>
			<div class="cr-legend-item"><code>${getName('spoiler-round', 'spr')}</code> <span class="cr-hidden-spoiler-round" title="${exampleText}">${exampleText}</span></div>
		`;

		containerEl.createEl('br');

		const variablesHeader = new Setting(containerEl)
			.setName(t('variables_header_name'))
			.setDesc(t('variables_header_desc'));

		variablesHeader.addButton((button) =>
			button
				.setButtonText(t('btn_add_variable'))
				.setCta()
				.onClick(async () => {
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
				event.dataTransfer?.setData('text/plain', index.toString());
			});
			variableRow.settingEl.addEventListener('dragover', (event) => {
				event.preventDefault();
				variableRow.settingEl.addClass('cr-drag-over');
			});
			variableRow.settingEl.addEventListener('dragleave', () => {
				variableRow.settingEl.removeClass('cr-drag-over');
			});
			variableRow.settingEl.addEventListener('drop', async (event) => {
				event.preventDefault();
				variableRow.settingEl.removeClass('cr-drag-over');
				const draggedIndex = parseInt(event.dataTransfer?.getData('text/plain') || '-1', 10);
				if (draggedIndex < 0 || draggedIndex === index) return;

				const item = this.plugin.settings.variables.splice(draggedIndex, 1)[0];
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
				text
					.setPlaceholder(t('placeholder_name'))
					.setValue(variable.name)
					.onChange(async (value) => {
						const nextValue = value.trim();
						const invalid = !isValidVarName(nextValue) || this.plugin.isDuplicateVarName(nextValue, index);
						text.inputEl.parentElement?.toggleClass('cr-error-input', invalid);
						if (invalid) return;

						variable.name = nextValue;
						await this.plugin.saveSettings({ refreshMode: 'debounced' });
					});
			});

			variableRow.addDropdown((drop) => {
				drop.selectEl.style.width = '85px';
				drop
					.addOption('string', t('type_string'))
					.addOption('number', t('type_number'))
					.addOption('boolean', t('type_boolean'))
					.setValue(variable.type)
					.onChange(async (value: CRVariable['type']) => {
						variable.type = value;
						if (value === 'boolean') variable.value = 'true';
						else if (value === 'number') variable.value = '0';
						else variable.value = '';
						await this.plugin.saveSettings({ refreshMode: 'debounced' });
						this.display();
					});
			});

			const valueWrapper = createDiv({ cls: 'cr-input-value' });
			variableRow.controlEl.appendChild(valueWrapper);

			if (variable.type === 'boolean') {
				new ToggleComponent(valueWrapper)
					.setValue(variable.value === 'true')
					.onChange(async (value) => {
						variable.value = String(value);
						await this.plugin.saveSettings({ refreshMode: 'debounced' });
					});
			} else {
				new TextComponent(valueWrapper)
					.setPlaceholder(t('placeholder_value'))
					.setValue(variable.value)
					.onChange(async (value) => {
						variable.value = variable.type === 'number' && value.trim() !== '' && Number.isFinite(Number(value))
							? String(Number(value))
							: value;
						await this.plugin.saveSettings({ refreshMode: 'debounced' });
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
					button
						.setIcon('star')
						.setTooltip(t('tooltip_set_default'))
						.onClick(async () => {
							this.plugin.settings.defaultVariable = variable.name;
							await this.plugin.saveSettings({ refreshMode: 'debounced' });
							this.display();
						}),
				);
			}

			variableRow.addExtraButton((button) =>
				button
					.setIcon('trash')
					.setTooltip(t('tooltip_delete'))
					.onClick(async () => {
						this.plugin.settings.variables.splice(index, 1);
						if (this.plugin.settings.defaultVariable === variable.name) {
							this.plugin.settings.defaultVariable = this.plugin.settings.variables[0]?.name ?? '';
						}
						await this.plugin.saveSettings({ refreshMode: 'debounced' });
						this.display();
					}),
			);
		});

		containerEl.createEl('hr');

		new Setting(containerEl)
			.setName(t('import_export_name'))
			.setDesc(t('import_export_desc'));

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

		const exportButton = btnContainer.createEl('button', { text: t('btn_export') });
		exportButton.addEventListener('click', () => {
			const jsonStr = JSON.stringify(this.plugin.settings.variables, null, 2);
			ioTextArea.setValue(jsonStr);
			this.importExportText = jsonStr;
		});

		const importButton = btnContainer.createEl('button', { text: t('btn_import'), cls: 'mod-cta' });
		importButton.addEventListener('click', async () => {
			try {
				const parsed = JSON.parse(this.importExportText);
				if (!Array.isArray(parsed)) throw new Error('Imported JSON must be an array');

				const variables = parsed
					.map((item, index) => normalizeVariable(item, index))
					.filter(Boolean) as CRVariable[];
				if (variables.length === 0) throw new Error('No valid variables found');

				const seen = new Set<string>();
				for (const variable of variables) {
					if (seen.has(variable.name)) throw new Error('Duplicate variable names');
					seen.add(variable.name);
				}

				this.plugin.settings.variables = variables;
				if (!seen.has(this.plugin.settings.defaultVariable)) {
					this.plugin.settings.defaultVariable = variables[0].name;
				}

				await this.plugin.saveSettings({ refreshMode: 'debounced' });
				new Notice(t('import_success'));
				this.display();
			} catch {
				new Notice(t('import_fail'));
			}
		});
	}
}

