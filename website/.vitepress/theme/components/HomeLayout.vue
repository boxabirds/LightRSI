<template>
  <div class="home-page">
    <!-- Background decor -->
    <div class="home-bg" aria-hidden="true">
      <div class="home-orb home-orb--1"></div>
      <div class="home-orb home-orb--2"></div>
      <div class="home-orb home-orb--3"></div>
      <div class="home-grid"></div>
    </div>
    <ParticleBg />

    <!-- Hero Section -->
    <section class="hero-section">
      <img src="/images/logo.svg" alt="LightRSI" class="hero-logo" />

      <a class="hero-announce" href="/LightRSI/hosts/compatibility">
        <span class="hero-announce-dot" aria-hidden="true"></span>
        New: OpenCode and pi adapters — six supported hosts
        <span class="hero-announce-arrow" aria-hidden="true">→</span>
      </a>

      <h1 class="hero-title">
        <span class="grad">LightRSI</span>
      </h1>

      <p class="hero-tagline">
        A modular runtime for recursive improvement in long-running LLM agents.<br>
        Build capabilities once and run them across six agent hosts, without a fork per host.
      </p>

      <p class="hero-sub">
        <strong>Featured plugin: TokenPilot</strong> — a cache-aware context runtime that reduces long-session token usage and cost.
      </p>

      <div class="hero-cta">
        <a href="/LightRSI/getting-started/quick-start" class="cta-primary">
          <svg class="cta-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Quick Start
        </a>
        <a href="/LightRSI/getting-started/install-lightrsi" class="cta-secondary">
          <svg class="cta-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Install
        </a>
        <a href="https://github.com/zjunlp/LightRSI" target="_blank" rel="noopener" class="cta-secondary">
          <svg class="cta-icon-svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
          GitHub
        </a>
        <a href="https://arxiv.org/abs/2606.17016" target="_blank" rel="noopener" class="cta-secondary">
          <svg class="cta-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          Paper
        </a>
      </div>

      <!-- KPI Row -->
      <div class="hero-kpi-row">
        <div class="hero-kpi">
          <div class="hero-kpi-num" data-count="95.7" data-count-suffix="%" data-count-dec="1">0%</div>
          <div class="hero-kpi-label">Fewer input tokens<br><span class="kpi-sub">vs. Vanilla · Claw-Eval continuous</span></div>
        </div>
        <div class="hero-kpi">
          <div class="hero-kpi-num" data-count="87.0" data-count-suffix="%" data-count-dec="1">0%</div>
          <div class="hero-kpi-label">Lower cost<br><span class="kpi-sub">vs. Vanilla · Claw-Eval continuous</span></div>
        </div>
        <div class="hero-kpi">
          <div class="hero-kpi-num" data-count="67.4" data-count-suffix="%" data-count-dec="1">0%</div>
          <div class="hero-kpi-label">Fewer input tokens<br><span class="kpi-sub">vs. Vanilla · PinchBench continuous</span></div>
        </div>
        <div class="hero-kpi">
          <div class="hero-kpi-num" data-count="6" data-count-suffix="" data-count-dec="0">0</div>
          <div class="hero-kpi-label">Agent hosts<br><span class="kpi-sub">OpenClaw · Codex · Claude Code<br>OpenCode · pi · DeepSeek Harness</span></div>
        </div>
      </div>
    </section>

    <!-- Architecture: Platform Overview -->
    <section class="landing-section reveal-section">
      <div class="section-container">
        <span class="section-kicker">Platform</span>
        <h2 class="section-title">
          Plugin platform for <span class="grad">long-running AI agents</span>
        </h2>
        <p class="section-sub">
          LightRSI separates improvement capabilities from shared runtime infrastructure and host integration, so each capability can be built once and evaluated consistently.
        </p>

        <div class="arch-card">
          <div class="arch-card-label">Platform Architecture</div>
          <div class="arch-row">
            <div class="arch-item">
              <div class="arch-item-icon">🧩</div>
              <div class="arch-item-title">Plugins</div>
              <div class="arch-item-desc">Reusable agent capabilities: context management, memory, and more.</div>
            </div>
            <div class="arch-item">
              <div class="arch-item-icon">⚙️</div>
              <div class="arch-item-title">Core Runtime</div>
              <div class="arch-item-desc">Plugin lifecycle, configuration, and host-independent execution engine.</div>
            </div>
            <div class="arch-item">
              <div class="arch-item-icon">🔌</div>
              <div class="arch-item-title">Host Adapters</div>
              <div class="arch-item-desc">Integration layer for six hosts, through a local proxy or gateway, or fully in-process.</div>
            </div>
            <div class="arch-item">
              <div class="arch-item-icon">🧭</div>
              <div class="arch-item-title">Products</div>
              <div class="arch-item-desc">Shared CLI, browser visual inspector, recovery MCP server, and Context Cleaner.</div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Supported Hosts -->
    <section class="landing-section reveal-section">
      <div class="section-container">
        <span class="section-kicker">Hosts</span>
        <h2 class="section-title">
          Runs <span class="grad">inside your agent</span>
        </h2>
        <p class="section-sub">
          The same TokenPilot preset binds to every host through a thin adapter. OpenClaw, Codex, and Claude Code route through a local proxy or gateway; OpenCode and pi run in-process.
        </p>

        <div class="host-grid">
          <a class="host-card" href="/LightRSI/hosts/openclaw">
            <span class="host-card-head">
              <span class="host-card-name">OpenClaw</span>
              <span class="host-tag host-tag--proxy">proxy</span>
            </span>
            <span class="host-card-desc">Bundled plugin with the richest surface: in-host commands, lifecycle eviction controls, and the visual inspector.</span>
          </a>
          <a class="host-card" href="/LightRSI/hosts/codex">
            <span class="host-card-head">
              <span class="host-card-name">Codex CLI</span>
              <span class="host-tag host-tag--proxy">proxy</span>
            </span>
            <span class="host-card-desc">Hooks plus a local Responses proxy, with the standalone <code>lightrsi codex</code> surface.</span>
          </a>
          <a class="host-card" href="/LightRSI/hosts/claude-code">
            <span class="host-card-head">
              <span class="host-card-name">Claude Code</span>
              <span class="host-tag host-tag--proxy">gateway</span>
            </span>
            <span class="host-card-desc">Anthropic-compatible gateway routing with observability hooks and real MCP recovery.</span>
          </a>
          <a class="host-card" href="/LightRSI/hosts/opencode">
            <span class="host-card-head">
              <span class="host-card-name">OpenCode</span>
              <span class="host-tag host-tag--inprocess">in-process</span>
            </span>
            <span class="host-card-desc">A v1 plugin plus the shared recovery MCP server. No proxy, and never rewrites your config comments.</span>
          </a>
          <a class="host-card" href="/LightRSI/hosts/pi">
            <span class="host-card-head">
              <span class="host-card-name">pi</span>
              <span class="host-tag host-tag--inprocess">in-process</span>
            </span>
            <span class="host-card-desc">An extension with a native recovery tool, since pi has no MCP. No pi-owned file is touched.</span>
          </a>
          <a class="host-card" href="/LightRSI/hosts/deepseek-harness">
            <span class="host-card-head">
              <span class="host-card-name">DeepSeek Harness</span>
              <span class="host-tag host-tag--plugin">plugin</span>
            </span>
            <span class="host-card-desc">A native Cordis plugin with durable session projection and opt-in canonical-surface eviction.</span>
          </a>
        </div>

        <div class="section-link-row">
          <a href="/LightRSI/hosts/compatibility" class="cta-secondary">Full capability matrix →</a>
        </div>
      </div>
    </section>

    <!-- Plugin Catalog -->
    <section class="landing-section reveal-section">
      <div class="section-container">
        <span class="section-kicker">Plugin Catalog</span>
        <h2 class="section-title">
          Available <span class="grad">plugins</span>
        </h2>
        <p class="section-sub">
          Each plugin provides a distinct capability. Install what you need, skip what you don't.
        </p>

        <div class="plugin-table-wrap">
          <table class="plugin-table">
            <thead>
              <tr>
                <th>Plugin</th>
                <th>Capability</th>
                <th>Status</th>
                <th>Hosts</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>TokenPilot</strong></td>
                <td>Cache-aware context management</td>
                <td><span class="status-stable">Stable</span></td>
                <td>
                  <div class="host-chips">
                    <span class="host-chip">OpenClaw</span>
                    <span class="host-chip">Codex</span>
                    <span class="host-chip">Claude Code</span>
                    <span class="host-chip">OpenCode</span>
                    <span class="host-chip">pi</span>
                    <span class="host-chip">DeepSeek Harness</span>
                  </div>
                </td>
              </tr>
              <tr>
                <td><strong>Context Cleaner</strong></td>
                <td>User-approved task-level context cleaning</td>
                <td><span class="status-stable">Stable</span></td>
                <td>
                  <div class="host-chips">
                    <span class="host-chip">OpenClaw</span>
                    <span class="host-chip">Codex</span>
                    <span class="host-chip">Claude Code</span>
                    <span class="host-chip">DeepSeek Harness</span>
                  </div>
                </td>
              </tr>
              <tr>
                <td><strong>Memory Plugin</strong></td>
                <td>Long-term memory</td>
                <td><span class="status-experimental">Experimental</span></td>
                <td><span class="tbd-text">TBD</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- Featured Plugin: TokenPilot -->
    <section class="landing-section reveal-section">
      <div class="section-container">
        <span class="section-kicker">Featured Plugin</span>
        <h2 class="section-title">
          TokenPilot: <span class="grad">cache-efficient context</span>
        </h2>
        <p class="section-sub">
          TokenPilot is the first official LightRSI plugin. It reduces token usage and cost in long-running agent sessions through stable-prefix rewriting, context reduction, and lifecycle-aware eviction.
        </p>

        <div class="feature-grid">
          <div class="feature-card">
            <h3>🔒 Stable Prefix</h3>
            <p>Rewrites developer-level context into a cache-stable form, dramatically improving cache hit rates across turns.</p>
          </div>
          <div class="feature-card">
            <h3>✂️ Context Reduction</h3>
            <p>Trims oversized tool output before it pollutes later turns, keeping the context window lean without losing signal.</p>
          </div>
          <div class="feature-card">
            <h3>🗑️ Context Eviction</h3>
            <p>Limits how much old context is carried forward as sessions grow, preventing unbounded context bloat.</p>
          </div>
          <div class="feature-card">
            <h3>📊 Reports & Visuals</h3>
            <p>Built-in inspector shows token savings, cache efficiency, and session metrics in real time.</p>
          </div>
        </div>

        <div class="section-link-row">
          <a href="/LightRSI/plugin-catalog/tokenpilot/overview" class="cta-primary">Explore TokenPilot →</a>
        </div>
      </div>
    </section>

    <!-- Documentation Directory -->
    <section class="landing-section reveal-section">
      <div class="section-container">
        <span class="section-kicker">Documentation</span>
        <h2 class="section-title">
          Browse the <span class="grad">docs</span>
        </h2>

        <div class="doc-dir-grid">

          <!-- Getting Started -->
          <a href="/LightRSI/getting-started/quick-start" class="doc-dir-card">
            <span class="doc-dir-icon">🚀</span>
            <span class="doc-dir-title">Getting Started</span>
            <span class="doc-dir-pages">What is LightRSI · Quick Start · Install · Your first plugin</span>
          </a>

          <!-- Hosts -->
          <a href="/LightRSI/hosts/compatibility" class="doc-dir-card">
            <span class="doc-dir-icon">🔌</span>
            <span class="doc-dir-title">Hosts</span>
            <span class="doc-dir-pages">OpenClaw · Codex · Claude Code · OpenCode · pi · DeepSeek Harness</span>
          </a>

          <!-- Plugin Catalog -->
          <a href="/LightRSI/plugin-catalog/overview" class="doc-dir-card">
            <span class="doc-dir-icon">🧩</span>
            <span class="doc-dir-title">Plugin Catalog</span>
            <span class="doc-dir-pages">TokenPilot preset · Context Cleaner · configuration and benchmarks</span>
          </a>

          <!-- Platform Concepts -->
          <a href="/LightRSI/platform-concepts/core-runtime" class="doc-dir-card">
            <span class="doc-dir-icon">🏗️</span>
            <span class="doc-dir-title">Platform Concepts</span>
            <span class="doc-dir-pages">Core Runtime · Plugins · Host Adapters · Lifecycle · Data and permissions</span>
          </a>

          <!-- User Guide -->
          <a href="/LightRSI/user-guide/managing-plugins" class="doc-dir-card">
            <span class="doc-dir-icon">📖</span>
            <span class="doc-dir-title">User Guide</span>
            <span class="doc-dir-pages">CLI Reference · Sessions · Visual Inspector · Logs · Uninstall</span>
          </a>

          <!-- Development -->
          <a href="/LightRSI/development/repository-structure" class="doc-dir-card">
            <span class="doc-dir-icon">🛠️</span>
            <span class="doc-dir-title">Development</span>
            <span class="doc-dir-pages">Repository structure · Local setup · Build and test · Contributing</span>
          </a>

        </div>
      </div>
    </section>

    <!-- Bottom CTA -->
    <section class="bottom-cta">
      <h2>Ready to reduce your agent costs?</h2>
      <p>Install LightRSI and TokenPilot in under 5 minutes, on any of the six supported hosts.</p>
      <a href="/LightRSI/getting-started/quick-start" class="cta-primary bottom-cta-btn">Get Started →</a>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import ParticleBg from './ParticleBg.vue'

onMounted(() => {
  // ── KPI count-up animation ──
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const fmt = (val: number, dec: number) =>
    val.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec })

  const animateCount = (el: HTMLElement) => {
    const target = parseFloat(el.dataset.count || '0')
    if (Number.isNaN(target)) return
    const dec = parseInt(el.dataset.countDec || '0', 10)
    const suffix = el.dataset.countSuffix || ''
    if (reduceMotion) {
      el.textContent = fmt(target, dec) + suffix
      return
    }
    const dur = 1500
    const start = performance.now()
    const step = (now: number) => {
      const p = Math.min((now - start) / dur, 1)
      const eased = 1 - Math.pow(1 - p, 3)
      el.textContent = fmt(target * eased, dec) + suffix
      if (p < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  const kpiObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          animateCount(e.target as HTMLElement)
          kpiObserver.unobserve(e.target)
        }
      })
    },
    { threshold: 0.4 }
  )

  document.querySelectorAll('[data-count]').forEach((el) => kpiObserver.observe(el))

  // ── Section scroll reveal ──
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('revealed')
          revealObserver.unobserve(e.target)
        }
      })
    },
    { threshold: 0.08 }
  )

  document.querySelectorAll('.reveal-section').forEach((el) => revealObserver.observe(el))
})
</script>

<style scoped>
/* scoped so it only applies inside this component */
</style>
