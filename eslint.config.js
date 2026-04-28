// ESLint v9 flat config. Permissive baseline appropriate for a static-site
// fork: catch syntax errors and undefined globals, don't fight the existing
// upstream code style. Tightening happens incrementally as new modules
// (spectral_bridge.js, spectral_worker.js) land in M3+.

export default [
  {
    ignores: [
      'example/**',
      'models/**',
      'node_modules/**',
      'test-results/**',
      'playwright-report/**',
      'coverage/**',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        // Browser standard
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        history: 'readonly',
        performance: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        Worker: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        fetch: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        Image: 'readonly',
        FileReader: 'readonly',
        // CommonJS UMD guard (used by piece files for optional Node-side import)
        module: 'readonly',
        // CDN-loaded
        THREE: 'readonly',
        OBJLoader: 'readonly',
        // Worker globals (used by js/spectral_worker.js)
        self: 'readonly',
        importScripts: 'readonly',
        loadPyodide: 'readonly',
        // Project globals — declared in script-loaded files, used across the codebase.
        // Marked 'writable' so no-redeclare doesn't fire on the declaring file.
        GameBoard: 'writable',
        BoardGraphics: 'writable',
        Models: 'writable',
        MoveManager: 'writable',
        Piece: 'writable',
        Rook: 'writable',
        Bishop: 'writable',
        Knight: 'writable',
        Queen: 'writable',
        King: 'writable',
        Pawn: 'writable',
        Bot: 'writable',
        PieceMovement: 'writable',
        Animation: 'writable',
        initTutorial: 'writable',
        checkWinCondition: 'writable',
      },
    },
    rules: {
      // Catches real bugs (typos, missing imports) without fighting legacy style.
      'no-undef': 'warn',
      // no-redeclare is noise in script-mode legacy code where multiple files
      // share globals via load-order. Tighten in M3+ for new modules.
      'no-redeclare': 'off',
      'no-unused-vars': 'off',
    },
  },
  // Tooling configs run in Node, with module semantics.
  {
    files: ['eslint.config.js', 'playwright.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
      },
    },
  },
  // Smoke and parity tests use Playwright globals + Node.
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
];
