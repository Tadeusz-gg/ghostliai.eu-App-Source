/**
 * Ghostli -- Application State & Configuration
 *
 * This module MUST be loaded first. It initializes the global namespace
 * `window.G` that all other renderer modules use to share state.
 *
 * Loaded via: <script src="renderer/state.js"></script>  (before script.js)
 */
(function () {
    'use strict';

    /* ---------------------------------------------------------------- */
    /*  DOM Element Cache                                                */
    /* ---------------------------------------------------------------- */

    const dom = {
        // Chat
        ta: document.querySelector('#text_write'),
        cc: document.querySelector('#chat_content'),
        fm: document.querySelector('.first_mess'),
        sb: document.querySelector('.sendbtn'),
        sc: document.querySelector('.sessioncontainer'),
        nsb: document.querySelector('.btnfm'),

        // Login
        loginScreen: document.querySelector('.loginscreen'),
        passwordInput: document.querySelector('#passwordInput'),
        loginDescription: document.querySelector('#loginDescription'),
        loginHint: document.querySelector('#loginHint'),
        eyeIcon: document.querySelector('#eyeIcon'),
        arrowIcon: document.querySelector('#arrowIcon'),
        closeLoginScreen: document.querySelector('.closeloginscreen'),

        // Loading / Onboarding
        loadingScreen: document.querySelector('.loadingscreen'),
        startupLoadingScreen: document.querySelector('.startup-loadingscreen'),
        onboardingScreen: document.querySelector('.onboardingscreen'),
        welcomeText: document.querySelector('.welcome-text'),
        assistantText: document.querySelector('.assistant-text'),
        preparingText: document.querySelector('.preparing-text'),
        loadingText: document.querySelector('.loading-text'),

        // Token auth
        authTokenScreen: document.querySelector('.authtoken'),
        tokenInputs: document.querySelectorAll('.token'),
        tokenDescription: document.querySelector('#tokenDescription'),
    };

    /* ---------------------------------------------------------------- */
    /*  Mutable Application State                                        */
    /* ---------------------------------------------------------------- */

    const state = {
        // Session
        cid: null,
        ss: {},
        ch: [],
        pns: false,
        af: [],
        ait: {},
        apr: {},

        // Activity
        lastActivityTime: Date.now(),
        timeoutTimer: null,

        // Settings
        defaultSettings: { autoDelete: false, turboMode: false },
        globalSettings: {
            notifications: true,
            temperature: 0.8,
            terminalAccess: false,
            customEmoticons: false,
            initialContext: '',
            windowSize: 'large',
            textZoom: 100,
            timeoutMinutes: null,
            aiModel: 'g-basic',
            aiTuneMode: 'default',
            aiTuneStyle: 'normal',
            aiContextLevel: 'balanced',
            tuneAiWebSearch: 'off',
            shortcutAlwaysOnTop: true,
            shortcutQuickPrompt: true
        },

        // Temperature modal
        temperatureModalShown: false,
        temperatureModalOpen: false,
        suppressNextTempModal: false,

        // Heartbeat
        heartbeatInterval: null,
        heartbeatActive: false,

        // Init
        isInitializing: false,
        initPromise: null,
        lastInitTime: 0,

        // Auth
        isFirstRun: false,
        passwordConfirmation: false,
        tempPassword: '',
        isShowingError: false,
        passwordConfirmationAttempts: 0,
        loginFailedAttempts: 0,
        authToken: '',
        deviceId: '',
        isAuthenticated: false,
        currentUser: null,

        // Live Code
        liveCodeFile: null,
        liveCodeEnabled: false,
        liveCodeVersions: [],

        // Live Workspace
        liveWorkspace: null,
        liveWorkspaceEnabled: false,

        // Repo Context
        repoContextFolder: null,
        repoContextEnabled: false,

        // Context Building Engine (CBE)
        webRagEnabled: false,
        repoContextIndex: {
            files: [],
            fileTreeText: '',
            stats: { totalFiles: 0, indexedFiles: 0, totalBytes: 0 },
            errors: []
        },

        // Draft / Save
        draftSaveTimeout: null,
        saveTimeout: null,

        // Session menu
        currentMenu: null,
        _sessionMenuScrollHandler: null,
    };

    /* ---------------------------------------------------------------- */
    /*  Constants                                                        */
    /* ---------------------------------------------------------------- */

    const K = Object.freeze({
        HEARTBEAT_INTERVAL: 30_000,
        INIT_DEBOUNCE_TIME: 1_000,
        SAVE_DELAY: 1_000,
        DRAFT_SAVE_DELAY: 1_000,
        LIVE_CODE_SAVE_DELAY: 1_000,

        MAX_PASSWORD_CONFIRMATION_ATTEMPTS: 2,
        MAX_LOGIN_FAILED_ATTEMPTS: 3,
        MAX_LIVE_CODE_VERSIONS: 6,

        LIVE_CODE_MAX_FILE_SIZE: 150 * 1024,
        LIVE_CODE_MAX_CONTEXT_CHARS: 12_000,
        LIVE_CODE_TRUNCATE_HEAD_LINES: 400,
        LIVE_CODE_TRUNCATE_TAIL_LINES: 150,

        REPO_MAX_FILES: 800,
        REPO_MAX_FILE_BYTES: 400 * 1024,
        REPO_TOTAL_CHAR_BUDGET: 350_000,
        REPO_SNIPPET_CONTEXT: 5,
    });

    /* ---------------------------------------------------------------- */
    /*  Lookup tables                                                    */
    /* ---------------------------------------------------------------- */

    

    /** File extension → Prism.js language identifier */
    const syntaxMap = {
        '.js': 'javascript', '.ts': 'typescript', '.jsx': 'javascript', '.tsx': 'typescript',
        '.py': 'python', '.java': 'java', '.cpp': 'cpp', '.c': 'c', '.cs': 'csharp',
        '.php': 'php', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.swift': 'swift',
        '.kt': 'kotlin', '.scala': 'scala', '.sh': 'bash', '.bat': 'batch',
        '.ps1': 'powershell', '.r': 'r', '.m': 'matlab', '.sql': 'sql', '.lua': 'lua',
        '.dart': 'dart', '.elm': 'elm', '.clj': 'clojure', '.hs': 'haskell',
        '.ml': 'ocaml', '.fs': 'fsharp', '.vb': 'vb', '.pl': 'perl', '.asm': 'assembly',
        '.html': 'html', '.htm': 'html', '.css': 'css', '.scss': 'scss', '.sass': 'sass',
        '.less': 'less', '.vue': 'vue', '.svelte': 'svelte', '.json': 'json', '.xml': 'xml',
        '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.ini': 'ini', '.cfg': 'ini',
        '.conf': 'apache', '.env': 'bash', '.dockerfile': 'dockerfile',
        '.makefile': 'makefile', '.gradle': 'gradle', '.cmake': 'cmake',
        '.md': 'markdown', '.txt': 'text', '.log': 'log', '.csv': 'csv', '.tsv': 'csv',
        '.rtf': 'rtf', '.png': 'image', '.jpg': 'image', '.exe': 'executable'
    };

    /* ---------------------------------------------------------------- */
    /*  Expose as global namespace                                       */
    /* ---------------------------------------------------------------- */

    window.G = {
        dom,
        state,
        K,

        syntaxMap,
    };

})();

