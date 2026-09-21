const themeConfig = {
    init() {
        const saved = localStorage.getItem('theme-preference') || 'system';
        this.apply(saved);
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        if (mediaQuery.addEventListener) {
            mediaQuery.addEventListener('change', () => { if (this.current() === 'system') this.apply('system'); });
        }
    },
    current() { return localStorage.getItem('theme-preference') || 'system'; },
    cycle() {
        const current = this.current();
        let next = current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light';
        this.apply(next);
        return next;
    },
    apply(mode) {
        localStorage.setItem('theme-preference', mode);
        const root = document.documentElement;
        let target = 'dark';
        root.removeAttribute('data-theme');
        root.setAttribute('data-theme', target);
        this.updateUI();
    },
    updateUI() {
        const mode = this.current();
        document.querySelectorAll('.theme-btn, .theme-option').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-theme') === mode);
        });
    }
};

window.themeConfig = themeConfig;

document.addEventListener('DOMContentLoaded', async () => {
    themeConfig.init();
    try {
        if (window.api) {
            const v = await window.api.invoke('get-app-version');
            if (v) {
                document.querySelectorAll('.app-version, .version-tag, .version-info, #app-version, #settings-app-ver').forEach(el => {
                    if (el.tagName === 'SPAN' || el.classList.contains('version-tag')) el.textContent = v;
                    else if (el.classList.contains('app-version')) el.textContent = v;
                });
            }
        }
    } catch(e) {}

    document.querySelectorAll('.theme-btn, .theme-option').forEach(btn => {
        btn.addEventListener('click', () => { themeConfig.apply(btn.getAttribute('data-theme')); });
    });
});
