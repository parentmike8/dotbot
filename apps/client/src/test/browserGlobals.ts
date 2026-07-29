/**
 * The handful of browser globals Pixi touches while its modules are still loading.
 *
 * The renderer's `model/` tree was deliberately free of pixi *values* — every file
 * imported `Graphics` as a type only — which is what let a drawing function be tested
 * against a stub in a plain node environment. That was a good property and it has now
 * been spent, on purpose: `FillGradient` is a real class, gradients are how a flat vector
 * shape becomes a material, and the whole world needs them.
 *
 * So the choice was between contorting the drawing code to keep pixi out of it and
 * teaching the test runner one fact about the environment. This is the second, and it
 * stays tiny deliberately: nothing here pretends to be a DOM, and any test that needs a
 * real one should say so rather than growing this file.
 *
 * `isSafari()` runs at pixi's module scope and reads `navigator.userAgent`. That is all
 * that is actually required — the rest is here because a partial `window` is worse than
 * none, and a test that reaches for `document` should fail loudly rather than on a
 * missing property three frames deep.
 */

type Mutable = Record<string, unknown>;
const globals = globalThis as unknown as Mutable;

if (typeof globals.navigator === "undefined") {
  globals.navigator = { userAgent: "node", platform: "node", maxTouchPoints: 0 };
}

if (typeof globals.window === "undefined") {
  globals.window = globals;
}
