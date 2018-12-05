const path = require('path');
const fsExtra = require('fs-extra');
const globby = require('globby');
const SingleEntryPlugin = require('webpack/lib/SingleEntryPlugin');
const MultiEntryPlugin = require('webpack/lib/MultiEntryPlugin');
const LoaderTargetPlugin = require('webpack/lib/LoaderTargetPlugin');
const FunctionModulePlugin = require('webpack/lib/FunctionModulePlugin');
const NodeSourcePlugin = require('webpack/lib/node/NodeSourcePlugin');
const JsonpTemplatePlugin = require('webpack/lib/web/JsonpTemplatePlugin');
const { ConcatSource } = require('webpack-sources');

const pluginName = 'MiniProgramWebpackPlugin';
module.exports = class MiniProgramWebpackPlugin {

	constructor(options = {}) {
		this.options = Object.assign({}, {
			clear: true,
			extensions: ['.js', '.ts'], // script ext
			include: [], // include assets file
			exclude: [], // ignore assets file
			assetsChunkName: '__assets_chunk_name__'
		}, options);
	}

	apply(compiler) {

		this.enforceTarget(compiler);

		compiler.hooks.run.tapPromise(pluginName, this.setAppEntries.bind(this));
		compiler.hooks.watchRun.tapPromise(pluginName, this.setAppEntries.bind(this));

		compiler.hooks.compilation.tap(pluginName, this.compilationHooks.bind(this));

		let firstInit = true;
		compiler.hooks.emit.tapPromise(pluginName, async compilation => {
			const { clear } = this.options;
			if (clear && firstInit) {
				firstInit = false;
				await MiniProgramWebpackPlugin.clearOutPut(compilation);
			}
			await this.emitAssetsFile(compilation);
		});

		compiler.hooks.done.tap(pluginName, () => {
			console.log('build success');
		});

	}

	compilationHooks(compilation) {
		compilation.chunkTemplate.hooks.render.tap(pluginName, (modules, chunk) => {
			if (this.appEntries.includes(chunk.name)) {
				const requireModules = modules.listMap().children[Object.keys(modules.listMap().children).pop()].generatedCode.split(',');
				const source = new ConcatSource(modules);
				const relativeRuntime = path.relative(path.dirname(chunk.name), './runtime').replace(/\\/g, '/');
				const relativeCommon = path.relative(path.dirname(chunk.name), './commons').replace(/\\/g, '/');
				const relativeVendors = path.relative(path.dirname(chunk.name), './vendors').replace(/\\/g, '/');
				// to rewrite ===4 require commomjs ===5 require ventdors.js
				source.add(`;require("${relativeRuntime}")`);
				if (requireModules.length >= 4) {
					source.add(`;require("${relativeCommon}")`);
				}
				if (requireModules.length >= 5) {
					source.add(`;require("${relativeVendors}")`);
				}
				return source;
			}
			return modules;
		});
		// splice assets module
		compilation.hooks.beforeChunkAssets.tap(pluginName, () => {
			const assetsChunkIndex = compilation.chunks.findIndex(
				({ name }) => name === this.options.assetsChunkName
			);
			if (assetsChunkIndex > -1) {
				compilation.chunks.splice(assetsChunkIndex, 1);
			}
		});
	}

	async enforceTarget(compiler) {
		const { options } = compiler;
		options.optimization.runtimeChunk = { name: 'runtime' };
		options.optimization.splitChunks.cacheGroups = {
			default: false,
			//node_modules
			vendor: {
				chunks: 'all',
				test: /[\\/]node_modules[\\/]/,
				name: 'vendors',
				minChunks: 0
			},
			//其他公用代码
			common: {
				chunks: 'all',
				test: /[\\/]src[\\/]/,
				minChunks: 2,
				name: 'commons',
				minSize: 0
			}
		};
		// set jsonp obj motuned obj
		options.output.globalObject = 'global';

		if (!options.node || options.node.global) {
			options.node = options.node || {};
			options.node.global = false;
		}
		// set target to web
		options.target = compiler => {
			new JsonpTemplatePlugin(options.output).apply(compiler);
			new FunctionModulePlugin(options.output).apply(compiler);
			new NodeSourcePlugin(options.node).apply(compiler);
			new LoaderTargetPlugin('web').apply(compiler);
		};
	}

	async setAppEntries(compiler) {
		const appEntry = compiler.options.entry.app;
		if (!appEntry) {
			throw new TypeError('Entry invalid.');
		}
		try {
			this.basePath = path.resolve(path.dirname(appEntry));
			this.appEntries = await this.resolveAppEntries();
			await this.addAssetsEntries(compiler);
			await this.addScriptEntry(compiler);
		} catch (error) {
			console.log(error);
		}
	}

	// resolve tabbar page compoments
	async resolveAppEntries() {
		const { tabBar = {}, pages = [], subpackages = [] } = fsExtra.readJSONSync(path.resolve(this.basePath, 'app.json'));

		let tabBarAssets = new Set();
		let components = new Set();

		for (const { iconPath, selectedIconPath } of (tabBar.list || [])) {
			if (iconPath) {
				tabBarAssets.add(iconPath);
			}
			if (selectedIconPath) {
				tabBarAssets.add(selectedIconPath);
			}
		}

		// parse subpage
		for (const subPage of subpackages) {
			for (const page of (subPage.pages || [])) {
				pages.push(path.join(subPage.root, page));
			}
		}

		// resolve page components
		for (const page of pages) {
			await this.getComponents(components, path.resolve(this.basePath, page));
		}

		components = Array.from(components) || [];
		tabBarAssets = Array.from(tabBarAssets) || [];

		const ret = ['app', ...pages, ...components];
		Object.defineProperties(ret, {
			pages: {
				get: () => pages
			},
			components: {
				get: () => components
			},
			tabBarAssets: {
				get: () => tabBarAssets
			}
		});
		return ret;
	}

	// add script entry
	async addScriptEntry(compiler) {
		this.appEntries
			.filter(resource => resource !== 'app')
			.forEach(resource => {
				const fullPath = this.getFullScriptPath(resource);
				new SingleEntryPlugin(this.basePath, fullPath, resource).apply(compiler);
			});
	}

	// add assets entry
	async addAssetsEntries(compiler) {
		const { include, exclude, extensions, assetsChunkName } = this.options;
		const patterns = this.appEntries.map(resource => `${resource}.*`).concat(include);
		const entries = await globby(patterns, {
			cwd: this.basePath,
			nodir: true,
			realpath: true,
			ignore: [...extensions.map(ext => `**/*${ext}`), ...exclude],
			dot: false
		});
		entries.push(...this.appEntries.tabBarAssets);
		this.assetsEntry = entries || [];
		new MultiEntryPlugin(this.basePath, entries, assetsChunkName).apply(compiler);
	}

	// parse components
	async getComponents(components, instance) {
		const {
			usingComponents = {}
		} = fsExtra.readJSONSync(`${instance}.json`);
		const componentBase = path.parse(instance).dir;
		for (const c of Object.values(usingComponents)) {
			const component = path.resolve(componentBase, c);
			if (!components.has(component) && c.indexOf('plugin://') !== 0) {
				components.add(path.relative(this.basePath, component));
				await this.getComponents(components, component);
			}
		}
	}

	async emitAssetsFile(compilation) {
		const emitAssets = [];
		for (let entry of this.assetsEntry) {
			const assets = path.resolve(this.basePath, entry);
			if (/\.(sass|scss|css|less|styl)$/.test(assets)) {
				continue;
			}
			const toTmit = async () => {
				const stat = await fsExtra.stat(assets);
				const source = await fsExtra.readFile(assets);
				compilation.assets[entry] = {
					size: () => stat.size,
					source: () => source
				};
			};
			emitAssets.push(toTmit());
		}
		await Promise.all(emitAssets);
	}

	// script full path
	getFullScriptPath(script) {
		const {
			basePath,
			options: { extensions }
		} = this;
		for (const ext of extensions) {
			const fullPath = path.resolve(basePath, script + ext);
			if (fsExtra.existsSync(fullPath)) {
				return fullPath;
			}
		}
	}

	static async clearOutPut(compilation) {
		const { path } = compilation.options.output;
		await fsExtra.remove(path);
	}
};
