// ==UserScript==
// @name         Colruyt.be nutritional info
// @namespace    https://github.com/duncannah
// @version      0.1
// @description  Display nutritional info quickly on colruyt.be product list and product pages
// @author       duncannah
// @match        https://www.colruyt.be/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=colruyt.be
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-end
// ==/UserScript==

// Helpers
class TimerQueue {
	constructor(delay = 1000) {
		this.delay = delay;
		this.timer = Promise.resolve();
	}

	add(fn = () => {}) {
		this.timer = this.timer.catch(console.error).then(() => {
			return new Promise((resolve) => setTimeout(() => resolve(fn()), this.delay));
		});

		return this.timer;
	}
}

const timerQueue = new TimerQueue();

const fetch = (url, options = {}) =>
	timerQueue.add(
		() =>
			new Promise((resolve, reject) =>
				GM_xmlhttpRequest({
					method: "GET",
					url,
					...options,
					onload: (res) =>
						resolve(new Response(res.responseText, { status: res.status })),
					onerror: (err) => reject(err),
				})
			)
	);

const getCache = (key) => {
	try {
		return JSON.parse(GM_getValue("cache_" + key, "{}"));
	} catch (e) {
		return {};
	}
};

const setCache = (key, cache) => {
	GM_setValue("cache_" + key, JSON.stringify(cache));
};

const waitForEl = (selector, toObserve = document) =>
	new Promise((resolve) => {
		const el = toObserve.querySelector(selector);
		if (el) return resolve(el);

		const observer = new MutationObserver((mutations) => {
			mutations.forEach(() => {
				const el = toObserve.querySelector(selector);
				if (el) {
					observer.disconnect();
					resolve(el);
				}
			});
		});

		observer.observe(toObserve, {
			childList: true,
			subtree: true,
		});
	});

// Observers
const productPageObserver = new MutationObserver((mutations) => {
	mutations.forEach(() => {
		const items = document.querySelectorAll(
			".assortment-overview > .grid > a:not(.DUNCANNAH_NUTRITIONAL_INFO)"
		);

		items.forEach((item) => {
			item.classList.add("DUNCANNAH_NUTRITIONAL_INFO");
			productPage_handleItem(item);
		});
	});
});

productPageObserver.observe(document.body, {
	childList: true,
	subtree: true,
});

const productPage_handleItem = async (item) => {
	const articleNumber = parseInt(item.getAttribute("technicalarticlenumber"), 10);
	if (!articleNumber) return;

	const infoEl = document.createElement("div");
	infoEl.innerHTML = "...";

	await waitForEl(".price-info__unit-price", item);

	item.querySelector(".price-info__unit-price").style.textAlign = "right";
	item.querySelector(".price-info__unit-price").prepend(infoEl);

	const info = await getProductInfo(articleNumber);
	if (!info || !info.enKcal) {
		infoEl.innerHTML = "\u2014";
		return;
	}

	infoEl.innerHTML = `${info.enKcal} <sub>kcal/${info.perUnit}</sub>`;
};

const getProductInfo = async (articleNumber) => {
	const cache = getCache(articleNumber);
	if (cache && cache.timestamp > Date.now() - 1000 * 60 * 60 * 24) return cache;

	return fetch(`https://fic.colruytgroup.com/productinfo/en/algc/${articleNumber}`)
		.then((res) => res.text())
		.then((text) => {
			const parser = new DOMParser();
			const doc = parser.parseFromString(text, "text/html");
			const infoEl = doc.querySelector(
				"#voedingswaarden > div >.row.values > div:first-child"
			);
			if (!infoEl) {
				setCache(articleNumber, { timestamp: Date.now() });
				return null;
			}

			const perUnit =
				infoEl
					.querySelector(".subtitle")
					.innerText.match(/per.(.+)/)[1]
					?.trim() ?? "100g";

			const keys = {
				"Energy kJ": "enKj",
				"Energy kcal": "enKcal",
				"Total fat": "fat",
				Fat: "satFat",
				Carbohydrate: "carbs",
				Sugars: "sugars",
				Fibre: "fibre",
				Protein: "protein",
				Salt: "salt",
			};

			const info = {
				perUnit,
				...Object.fromEntries(
					Array.from(infoEl.getElementsByClassName("value-detail"))
						.map((el) => {
							const name = el.querySelector(".val-name").innerText;

							if (keys[name]) {
								const value = parseInt(el.querySelector(".val-nbr").innerText, 10);
								if (!value) return;

								return [[keys[name]], value];
							}
						})
						.filter(Boolean)
				),
			};

			// if kj is present but kcal is not, calculate it
			if (info.enKj && !info.enKcal) info.enKcal = Math.round(info.enKj / 4.184);

			if (info.enKcal == null) return null;

			setCache(articleNumber, { ...info, timestamp: Date.now() });

			return info;
		});
};
