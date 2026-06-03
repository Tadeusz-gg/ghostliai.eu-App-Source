// Custom Find Widget Logic (DOM-based)
(function () {
    const findWidget = document.getElementById('find-widget');
    const findInput = document.getElementById('find-input');
    const findCount = document.getElementById('find-count');
    const btnNext = document.getElementById('find-next');
    const btnPrev = document.getElementById('find-prev');
    const btnClose = document.getElementById('find-close');
    const btnMatchCase = document.getElementById('find-match-case');
    const btnMatchWord = document.getElementById('find-match-word');

    // The container where we want to search
    const SEARCH_CONTAINER_ID = 'chat_content'; // Ensure this ID exists in your HTML

    let state = {
        visible: false,
        text: '',
        matchCase: false,
        matchWord: false,
        matches: [],     // Array of DOM elements (spans)
        currentIndex: -1 // 0-based index of current active match
    };

    /**
     * Toggles widget visibility
     */
    function toggleWidget() {
        state.visible = !state.visible;
        if (state.visible) {
            findWidget.classList.add('visible');
            findInput.focus();
            findInput.select();
            performSearch(); // Search immediately if there's text
        } else {
            findWidget.classList.remove('visible');
            clearHighlights();
            findWidget.blur();
            // Refocus text area if needed
            const ta = document.querySelector('.text_write');
            if (ta) ta.focus();
        }
    }

    /**
     * Clears all highlights from the search container
     * Resets the DOM to original state (removes span wrappers)
     */
    function clearHighlights() {
        const container = document.getElementById(SEARCH_CONTAINER_ID);
        if (!container) return;

        // We need to find all .ghostli-highlight elements and unwrap them
        // Use a loop because getElementsByClassName is live
        const highlights = container.querySelectorAll('.ghostli-highlight');
        highlights.forEach(el => {
            const parent = el.parentNode;
            if (parent) {
                parent.replaceChild(document.createTextNode(el.textContent), el);
                parent.normalize(); // Merge adjacent text nodes
            }
        });

        state.matches = [];
        state.currentIndex = -1;
        updateUI();
    }

    /**
     * Recursive function to find text nodes
     */
    function getTextNodes(node) {
        let textNodes = [];
        if (node.nodeType === 3) { // Text node
            // Filter out empty or whitespace-only nodes if desired, but keep for now
            if (node.nodeValue.length > 0) {
                textNodes.push(node);
            }
        } else {
            // Traverse children
            // Skip script/style tags or hidden elements if necessary
            if (node.tagName !== 'SCRIPT' && node.tagName !== 'STYLE' && node.tagName !== 'TEXTAREA' && node.tagName !== 'INPUT') {
                for (let i = 0; i < node.childNodes.length; i++) {
                    textNodes = textNodes.concat(getTextNodes(node.childNodes[i]));
                }
            }
        }
        return textNodes;
    }

    /**
     * Performs the search and highlights matches
     */
    function performSearch() {
        // 1. Clear existing
        clearHighlights();

        const searchText = findInput.value;
        state.text = searchText;

        if (!searchText) {
            updateUI();
            return;
        }

        const container = document.getElementById(SEARCH_CONTAINER_ID);
        if (!container) return;

        // 2. Get all text nodes in the container
        // We traverse deep.
        const textNodes = getTextNodes(container);

        // 3. Regex for finding
        const flags = state.matchCase ? 'g' : 'gi';
        // Escape special regex chars in search text
        const escapedText = searchText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        let pattern = escapedText;
        if (state.matchWord) {
            pattern = `\\b${pattern}\\b`;
        }

        const regex = new RegExp(pattern, flags);

        // 4. Highlight matches
        let matchCount = 0;
        let newMatches = [];

        // Note: iterating backwards is often safer when modifying DOM, but here we replace nodes.
        // We need to be careful not to invalidate our list of textNodes if we modify the tree?
        // Actually, if we modify a text node, it splits.
        // Let's iterate and build a list of replacements.

        textNodes.forEach(node => {
            const text = node.nodeValue;
            let match;
            let lastIndex = 0;
            let fragments = [];
            let found = false;

            // Reset regex lastIndex just in case
            regex.lastIndex = 0;

            // Simple string matching might be safer/easier than regex exec loop for simple replacements
            // taking regex for case/word options

            // We use simple split/join logic or regex replace logic
            // But we need to keep references to the new elements to navigate them.

            // Let's try to find matches in this node
            const matchesInNode = [];
            let myMatch;
            while ((myMatch = regex.exec(text)) !== null) {
                matchesInNode.push({
                    index: myMatch.index,
                    length: myMatch[0].length,
                    text: myMatch[0]
                });

                // Avoid infinite loop with zero-width matches (shouldn't happen with valid text search)
                if (regex.lastIndex === myMatch.index) {
                    regex.lastIndex++;
                }
            }

            if (matchesInNode.length > 0) {
                const parent = node.parentNode;
                if (!parent) return;

                // Create a fragment to hold replacements
                const fragment = document.createDocumentFragment();
                let cursor = 0;

                matchesInNode.forEach(m => {
                    // Text before match
                    if (m.index > cursor) {
                        fragment.appendChild(document.createTextNode(text.substring(cursor, m.index)));
                    }

                    // The Match
                    const span = document.createElement('span');
                    span.className = 'ghostli-highlight';
                    span.textContent = m.text; // Preserve original case from text, not search query
                    fragment.appendChild(span);
                    newMatches.push(span);

                    cursor = m.index + m.length;
                });

                // Text after last match
                if (cursor < text.length) {
                    fragment.appendChild(document.createTextNode(text.substring(cursor)));
                }

                // Replace the text node with the fragment
                parent.replaceChild(fragment, node);
            }
        });

        // 5. Store matches
        state.matches = newMatches; // DOM elements are in document order usually because of traversal order

        if (state.matches.length > 0) {
            state.currentIndex = 0;
            highlightCurrent();
            scrollToCurrent();
        } else {
            state.currentIndex = -1;
        }

        updateUI();
    }

    function highlightCurrent() {
        // Remove active class from all
        state.matches.forEach((el, idx) => {
            if (idx === state.currentIndex) {
                el.classList.add('active');
            } else {
                el.classList.remove('active');
            }
        });
    }

    function scrollToCurrent() {
        if (state.currentIndex >= 0 && state.matches[state.currentIndex]) {
            const el = state.matches[state.currentIndex];
            el.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
                inline: 'center'
            });
        }
    }

    function nextMatch() {
        if (state.matches.length === 0) return;
        state.currentIndex++;
        if (state.currentIndex >= state.matches.length) {
            state.currentIndex = 0; // Loop
        }
        highlightCurrent();
        scrollToCurrent();
        updateUI();
    }

    function prevMatch() {
        if (state.matches.length === 0) return;
        state.currentIndex--;
        if (state.currentIndex < 0) {
            state.currentIndex = state.matches.length - 1; // Loop
        }
        highlightCurrent();
        scrollToCurrent();
        updateUI();
    }

    function updateUI() {
        if (state.matches.length === 0) {
            if (state.text) {
                findCount.textContent = 'No results';
            } else {
                findCount.textContent = 'No results';
            }
            btnNext.classList.add('disabled');
            btnPrev.classList.add('disabled');
        } else {
            findCount.textContent = `${state.currentIndex + 1} of ${state.matches.length}`;
            btnNext.classList.remove('disabled');
            btnPrev.classList.remove('disabled');
        }
    }

    // --- Events ---

    findInput.addEventListener('input', () => {
        performSearch();
    });

    findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) {
                prevMatch();
            } else {
                nextMatch();
            }
        }
    });

    btnNext.addEventListener('click', nextMatch);
    btnPrev.addEventListener('click', prevMatch);
    btnClose.addEventListener('click', toggleWidget);

    btnMatchCase.addEventListener('click', () => {
        state.matchCase = !state.matchCase;
        btnMatchCase.classList.toggle('active', state.matchCase);
        performSearch();
    });

    btnMatchWord.addEventListener('click', () => {
        state.matchWord = !state.matchWord;
        btnMatchWord.classList.toggle('active', state.matchWord);
        performSearch();
    });

    // Global Keydown
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
            e.preventDefault();
            if (!state.visible) {
                toggleWidget();
            } else {
                // If already visible and text selected, maybe re-focus?
                findInput.focus();
                findInput.select();
            }
        }
        if (state.visible && e.key === 'Escape') {
            e.preventDefault();
            toggleWidget();
        }
    });

})();
