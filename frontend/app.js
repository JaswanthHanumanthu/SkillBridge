/* ============================================================================
   SkillBridge — Career opportunity platform
   Connected to the existing FastAPI API
   ============================================================================ */
(() => {
  "use strict";

  // DOM Helpers
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];

  // App State
  let currentUser = null;
  let currentView = "dashboard";
  let landingRole = "user";
  let masterSkills = [];
  let savedJobIds = new Set();
  let savedJobsCache = [];
  let editingAdminOpportunityId = null;
  let notificationUnreadCount = 0;
  let notificationFilter = "all";
  let notificationOffset = 0;
  let notificationHasMore = false;
  let notificationPollTimer = null;
  let notificationLoading = false;
  const notificationRecords = new Map();
  const NOTIFICATION_PAGE_SIZE = 20;
  let bridgeMateOpen = false;
  let bridgeMateBusy = false;
  let bridgeMateCategories = [];
  let bridgeMateHistory = [];
  let bridgeMateCurrentTopic = "";
  const ROLE_VIEWS = {
    user: new Set(["dashboard", "analytics", "recommendations", "jobs", "hackathons", "saved-jobs", "applications", "profile"]),
    recruiter: new Set(["dashboard", "analytics", "post-job", "recruiter-jobs", "recruiter-applicants", "company-profile"]),
    developer: new Set(["dashboard", "analytics", "dev-pending", "dev-links", "dev-companies", "dev-users", "dev-jobs", "dev-opportunity-form", "dev-applications"])
  };

  // --------------------------------------------------------------------------
  // Utility & UI Helpers
  // --------------------------------------------------------------------------
  function esc(v = "") {
    return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    }[c]));
  }

  function initials(name = "User") {
    return name.split(/\s+/).slice(0, 2).map(x => x[0] || "").join("").toUpperCase() || "U";
  }

  function refreshIcons() {
    if (window.lucide) {
      lucide.createIcons();
    }
  }

  function toast(message, isError = false) {
    const el = document.createElement("div");
    el.className = "toast" + (isError ? " error" : "");
    el.innerHTML = `
      <i data-lucide="${isError ? 'alert-circle' : 'check-circle'}"></i>
      <span>${esc(message)}</span>
    `;
    $("#toast-region").append(el);
    refreshIcons();
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 250);
    }, 3800);
  }

  function setFormBusy(form, busy) {
    const button = $('button[type="submit"]', form);
    if (!button) return;
    if (!button.dataset.idleHtml) button.dataset.idleHtml = button.innerHTML;
    form.setAttribute("aria-busy", busy ? "true" : "false");
    button.disabled = busy;
    button.innerHTML = busy ? '<span class="button-spinner" aria-hidden="true"></span> Please wait…' : button.dataset.idleHtml;
  }

  function associateFieldLabels(root) {
    $$('.form-field', root).forEach((field, index) => {
      const label = $('label', field);
      const control = $('input:not([type="hidden"]), select, textarea', field);
      if (!label || !control || label.htmlFor || control.id) return;
      control.id = `skillbridge-field-${index}-${Math.random().toString(36).slice(2, 7)}`;
      label.htmlFor = control.id;
    });
  }

  function formatCurrency(val) {
    if (!val || Number(val) === 0) return "Not specified";
    return "₹" + Number(val).toLocaleString("en-IN");
  }

  function formatDate(dStr) {
    if (!dStr) return "N/A";
    const d = new Date(dStr);
    return isNaN(d.getTime()) ? dStr : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  }

  function applicationStatusLabel(status = "") {
    const labels = { submitted: "Applied", under_review: "Under Review", shortlisted: "Shortlisted", interview: "Interview", selected: "Selected", rejected: "Rejected", withdrawn: "Withdrawn" };
    return labels[status] || String(status).replace(/_/g, " ");
  }

  function nextRecruiterStatuses(status) {
    return ({
      submitted: ["under_review", "rejected"],
      under_review: ["shortlisted", "rejected"],
      shortlisted: ["interview", "rejected"],
      interview: ["selected", "rejected"],
      selected: [], rejected: [], withdrawn: []
    })[status] || [];
  }

  function formatNotificationTime(value) {
    if (!value) return "Just now";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Recently" : date.toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  }

  function updateNotificationBadge(count) {
    notificationUnreadCount = Math.max(0, Number(count) || 0);
    const badge = $("#notification-badge");
    const markAll = $("#mark-all-notifications-read");
    if (!badge) return;
    badge.textContent = notificationUnreadCount > 99 ? "99+" : String(notificationUnreadCount);
    badge.classList.toggle("hidden", notificationUnreadCount === 0);
    badge.setAttribute("aria-label", `${notificationUnreadCount} unread notifications`);
    if (markAll) markAll.disabled = notificationUnreadCount === 0;
    const summary = $("#notification-summary");
    if (summary) summary.textContent = notificationUnreadCount ? `${notificationUnreadCount} unread update${notificationUnreadCount === 1 ? "" : "s"}` : "You’re up to date";
  }

  async function refreshNotificationUnreadCount() {
    if (!currentUser) return;
    try {
      const data = await api("/notifications/unread-count");
      updateNotificationBadge(data.unread_count);
    } catch (error) {
      // Keep the last known badge, but surface the backend failure in the center.
      const feedback = $("#notification-feedback");
      if (feedback) {
        feedback.textContent = `Notification count is unavailable: ${error.message || "Please try again."}`;
        feedback.classList.add("is-error");
      }
    }
  }

  function notificationNavigationLabel() {
    if (!currentUser) return "Open update";
    if (currentUser.role === "user") return "View application";
    if (currentUser.role === "recruiter") return "Review applicant";
    return "Open application audit";
  }

  async function loadNotificationList(reset = true) {
    const list = $("#notification-list");
    const feedback = $("#notification-feedback");
    const moreButton = $("#notification-load-more");
    if (!list || !currentUser || notificationLoading) return;
    notificationLoading = true;
    if (reset) {
      notificationOffset = 0;
      notificationRecords.clear();
      list.innerHTML = '<div class="notification-state notification-loading"><span class="button-spinner" aria-hidden="true"></span><br>Loading notifications…</div>';
    }
    feedback.textContent = "";
    feedback.classList.remove("is-error");
    try {
      const params = new URLSearchParams({ filter: notificationFilter, limit: String(NOTIFICATION_PAGE_SIZE), offset: String(notificationOffset) });
      const data = await api(`/notifications?${params}`);
      if (!data || !Array.isArray(data.notifications) || !Number.isFinite(Number(data.unread_count))) {
        throw new Error("The notification service returned an invalid response.");
      }
      updateNotificationBadge(data.unread_count);
      const items = data.notifications || [];
      items.forEach(item => notificationRecords.set(Number(item.id), item));
      const html = items.map(item => `
        <article class="notification-item ${item.is_read ? "is-read" : "is-unread"}">
          <button class="notification-open" type="button" data-notification-open="${Number(item.id)}" aria-label="${esc(notificationNavigationLabel())}: ${esc(item.title)}">
            <span class="notification-unread-dot" aria-hidden="true"></span>
            <span class="notification-copy"><b>${esc(item.title)}</b><span>${esc(item.message)}</span><small>${formatNotificationTime(item.created_at)} · ${esc(String(item.notification_type || "").replace(/_/g, " "))}</small></span>
          </button>
          ${item.is_read ? '<span aria-hidden="true"></span>' : `<button class="notification-mark-read" type="button" data-notification-read="${Number(item.id)}" aria-label="Mark ${esc(item.title)} as read"><i data-lucide="check"></i></button>`}
        </article>
      `).join("");
      if (reset) list.innerHTML = "";
      if (html) list.insertAdjacentHTML("beforeend", html);
      else if (reset) list.innerHTML = `<div class="notification-state notification-empty"><i data-lucide="${notificationFilter === "unread" ? "check-check" : "bell-ring"}"></i>${notificationFilter === "unread" ? "You’re all caught up." : "No notifications yet. Important application updates will appear here."}</div>`;
      notificationOffset += items.length;
      notificationHasMore = Boolean(data.has_more);
      moreButton?.classList.toggle("hidden", !notificationHasMore);
      refreshIcons();
    } catch (error) {
      if (reset) list.innerHTML = '<div class="notification-state notification-error" role="alert"><i data-lucide="triangle-alert"></i><span>Notifications could not be loaded.</span><button class="btn btn-outline btn-sm" type="button" data-notification-retry>Retry</button></div>';
      feedback.textContent = error.message || "Please try again.";
      feedback.classList.add("is-error");
      moreButton?.classList.add("hidden");
      refreshIcons();
    } finally {
      notificationLoading = false;
    }
  }

  async function markNotificationRead(notificationId) {
    try {
      const result = await api(`/notifications/${Number(notificationId)}/read`, { method: "PUT" });
      updateNotificationBadge(result.unread_count);
      await loadNotificationList(true);
    } catch (error) {
      const feedback = $("#notification-feedback");
      if (feedback) { feedback.textContent = error.message || "Unable to update this notification."; feedback.classList.add("is-error"); }
    }
  }

  async function markAllNotificationsRead() {
    const button = $("#mark-all-notifications-read");
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
      const result = await api("/notifications/read-all", { method: "PUT", body: JSON.stringify({}) });
      updateNotificationBadge(result.unread_count);
      await loadNotificationList(true);
    } catch (error) {
      button.disabled = false;
      const feedback = $("#notification-feedback");
      if (feedback) { feedback.textContent = error.message || "Unable to update notifications."; feedback.classList.add("is-error"); }
    }
  }

  async function openNotification(notificationId) {
    const item = notificationRecords.get(Number(notificationId));
    if (!item) return;
    if (!item.is_read) {
      try {
        const result = await api(`/notifications/${Number(notificationId)}/read`, { method: "PUT" });
        updateNotificationBadge(result.unread_count);
      } catch (error) {
        const feedback = $("#notification-feedback");
        if (feedback) { feedback.textContent = error.message || "Unable to update this notification."; feedback.classList.add("is-error"); }
        return;
      }
    }
    $("#notification-popover")?.classList.add("hidden");
    $("#notification-bell")?.setAttribute("aria-expanded", "false");
    if (item.related_application_id) {
      loadView(currentUser.role === "user" ? "applications" : currentUser.role === "recruiter" ? "recruiter-applicants" : "dev-applications");
    } else if (item.related_job_id && currentUser.role === "user") {
      loadView("jobs");
    }
  }

  function startNotificationPolling() {
    if (notificationPollTimer) clearInterval(notificationPollTimer);
    refreshNotificationUnreadCount();
    notificationPollTimer = setInterval(() => {
      if (!currentUser || document.hidden) return;
      refreshNotificationUnreadCount();
      if (!$("#notification-popover")?.classList.contains("hidden")) loadNotificationList(true);
    }, 90000);
  }

  function stopNotificationPolling() {
    if (notificationPollTimer) clearInterval(notificationPollTimer);
    notificationPollTimer = null;
    updateNotificationBadge(0);
  }

  function opportunitySourceLabel(job) {
    if (job.source_classification === "ADMIN_CURATED_VERIFIED") return "Verified Official Listing";
    if (job.source_classification === "ADMIN_CURATED_PROGRAM") return "Official Program";
    if (job.source_classification === "ADMIN_DEMO" || job.is_sample) return "SkillBridge Sample";
    return job.owner_type === "ADMIN" ? "Admin Curated" : "Recruiter Posted";
  }

  function renderSourceBadge(job) {
    const verified = job.source_classification === "ADMIN_CURATED_VERIFIED";
    const sample = job.source_classification === "ADMIN_DEMO" || job.is_sample;
    return `<span class="status-pill ${sample ? "pending" : verified ? "approved" : "published"}">${esc(opportunitySourceLabel(job))}</span>`;
  }

  function opportunityBranchLabel(job) {
    if (job.branch_eligibility === "all_branches") return "Open to all branches";
    if (job.branch_eligibility === "eligibility_unknown") return "Branch eligibility varies; check the official criteria";
    if (job.branch_eligibility === "branch_unknown") return `Eligibility unknown${job.eligible_branches?.length ? ` · Eligible branches: ${job.eligible_branches.join(", ")}` : " · Add your branch to check"}`;
    if (job.branch_eligibility === "not_eligible") return `Not eligible for ${job.candidate_branch || "your branch"} · Eligible: ${(job.eligible_branches || []).join(", ")}`;
    if (job.branch_eligibility === "eligible") return `Eligible for ${job.candidate_branch || "your branch"}${job.eligible_branches?.length ? ` · ${job.eligible_branches.join(", ")}` : ""}`;
    if (job.eligible_branches?.length) return `Eligible branches: ${job.eligible_branches.join(", ")}`;
    return "Open to all branches";
  }

  function opportunityDeadlineLabel(job) {
    if (!job.deadline) return "Deadline not specified";
    const days = Number(job.days_remaining);
    const urgency = Number.isFinite(days) && days <= 5 ? ` · Closing soon${days === 0 ? " · Last day" : ` · ${days} days left`}` : Number.isFinite(days) ? ` · ${days} days left` : "";
    return `Apply before ${formatDate(job.deadline)}${urgency}`;
  }

  function opportunityCompensationLabel(job) {
    const minimum = Number(job.salary_min) || 0;
    const maximum = Number(job.salary_max) || 0;
    if (minimum || maximum) return `${minimum ? formatCurrency(minimum) : ""}${minimum && maximum ? " – " : ""}${maximum ? formatCurrency(maximum) : ""}`;
    if (job.paid_status === "stipend") return "Stipend; amount not specified";
    if (job.paid_status === "paid") return "Paid; amount not specified";
    if (job.paid_status === "unpaid") return "Unpaid";
    if (job.paid_status === "prize") return "Prize details on official source";
    return "";
  }

  function candidateProfileCompletion(profileData = {}) {
    const profile = profileData.profile || {};
    const preferences = profileData.preferences || {};
    const sections = [
      { label: "Basic profile", done: !!(profile.full_name && profile.email && profile.phone && profile.bio) },
      { label: "Education", done: (profileData.education || []).length > 0 },
      { label: "Skills", done: (profileData.skills || []).length > 0 },
      { label: "Experience", done: (profileData.experience || []).length > 0 },
      { label: "Achievements", done: (profileData.achievements || []).length > 0 },
      { label: "Resume", done: (profileData.resumes || []).length > 0 },
      { label: "Opportunity preferences", done: !!(
        preferences.preferred_role && preferences.preferred_location &&
        (preferences.preferred_categories || []).length
      ) }
    ];
    const missing = sections.filter(section => !section.done).map(section => section.label);
    return { percentage: Math.round((sections.length - missing.length) * 100 / sections.length), missing };
  }

  // --------------------------------------------------------------------------
  // API Client Wrapper (with credentials)
  // --------------------------------------------------------------------------
  async function api(endpoint, options = {}) {
    const headers = {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    };

    const config = {
      credentials: "include",
      ...options,
      headers
    };

    try {
      const res = await fetch(`/api${endpoint}`, config);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        const errorMsg = data.error || `HTTP error ${res.status}`;
        throw new Error(errorMsg);
      }
      return data;
    } catch (err) {
      console.warn(`API Error [${endpoint}]:`, err.message);
      throw err;
    }
  }

  // --------------------------------------------------------------------------
  // Authentication & Session
  // --------------------------------------------------------------------------
  async function checkSession() {
    try {
      const data = await api("/auth/me");
      if (data.authenticated && data.user) {
        setSession(data.user);
      } else {
        showLandingScreen();
      }
    } catch {
      showLandingScreen();
    }
  }

  function setSession(user) {
    if (!user || !ROLE_VIEWS[user.role]) {
      showLandingScreen();
      return;
    }
    currentUser = user;
    $("#landing-screen").classList.add("hidden");
    $("#app-shell").classList.remove("hidden");

    // Update User Profile Details in Topbar & Sidebar
    const roleLabels = { user: "Candidate", recruiter: "Recruiter", developer: "Platform Administrator" };
    const displayName = user.name || user.username;
    const roleTitle = roleLabels[user.role] || user.role;

    $("#sidebar-user-name").textContent = displayName;
    $("#sidebar-user-role").textContent = roleTitle;
    $("#workspace-label").textContent = `${roleTitle.toUpperCase()} WORKSPACE`;
    $("#sidebar-avatar").textContent = initials(displayName);
    $("#sidebar-avatar").className = `avatar ${user.role}`;

    $("#top-name").textContent = displayName;
    $("#top-role").textContent = roleTitle;
    $("#global-search").parentElement.classList.toggle("hidden", user.role !== "user");
    $("#top-avatar").textContent = initials(displayName);
    $("#top-avatar").className = `avatar ${user.role}`;

    // Render Role Navigation
    renderSidebarNav();

    // Default view per role
    currentView = "dashboard";
    loadView(currentView);
    startNotificationPolling();
    mountBridgeMate();
  }

  function showLandingScreen() {
    stopNotificationPolling();
    currentUser = null;
    unmountBridgeMate();
    $("#app-shell").classList.add("hidden");
    $("#landing-screen").classList.remove("hidden");
    refreshIcons();
  }

  function selectLandingRole(role) {
    const roles = {
      user: { description: "Discover opportunities, track your progress, and develop your skills.", label: "Sign in as Candidate" },
      recruiter: { description: "Publish opportunities and identify suitable candidates.", label: "Sign in as Recruiter" },
      developer: { description: "Manage platform activity, users, and opportunities.", label: "Sign in as Platform Admin" },
    };
    if (!roles[role]) return;
    landingRole = role;
    $$("[data-landing-role]").forEach(button => {
      const selected = button.dataset.landingRole === role;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    $("#landing-expected-role").value = role;
    $("#landing-role-description").textContent = roles[role].description;
    $("#landing-login-submit span").textContent = roles[role].label;
    const isAdmin = role === "developer";
    $("#landing-create-account-prompt").classList.toggle("hidden", isAdmin);
    $("#landing-admin-note").classList.toggle("hidden", !isAdmin);
    $("#landing-login-error").textContent = "";
  }

  async function handleLogout() {
    try {
      await api("/auth/logout", { method: "POST" });
      currentUser = null;
      showLandingScreen();
      toast("Successfully logged out.");
    } catch (e) {
      toast("Could not end your session. Please try again.", true);
    }
  }

  // --------------------------------------------------------------------------
  // BridgeMate — reviewed FAQ first, labelled Gemini fallback for weak matches.
  // --------------------------------------------------------------------------
  function formatBridgeMateAnswer(value = "") {
    return esc(value)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/^\s*[•-]\s+/gm, "• ")
      .replace(/\n/g, "<br>");
  }

  function renderBridgeMateMessages() {
    const list = $("#bridgemate-messages");
    if (!list) return;
    list.innerHTML = bridgeMateHistory.map(message => {
      const suggestions = (message.quick_prompts || []).length
        ? `<div class="bridgemate-suggestions">${message.quick_prompts.map(prompt => `<button type="button" class="bridgemate-prompt" data-bridge-prompt="${esc(prompt)}">${esc(prompt)}</button>`).join("")}</div>`
        : "";
      const heading = message.title ? `<b class="bridgemate-message-title">${esc(message.title)}</b>` : "";
      const label = message.matched === false ? '<small class="bridgemate-unmatched-label">No strong reviewed FAQ match</small>' : "";
      const modeLabel = message.mode === "gemini" ? '<small class="bridgemate-ai-label">AI-generated general guidance · verify current details</small>' : "";
      const retry = message.retryQuery ? `<button class="bridgemate-retry" type="button" data-bridge-retry="${esc(message.retryQuery)}">Retry</button>` : "";
      return `<article class="bridgemate-message ${message.role === "user" ? "from-user" : "from-assistant"} ${message.error ? "has-error" : ""}">${label}${heading}${modeLabel}<div>${formatBridgeMateAnswer(message.text)}</div>${message.category_label ? `<small class="bridgemate-category">${esc(message.category_label)}</small>` : ""}${suggestions}${retry}</article>`;
    }).join("");
    list.scrollTop = list.scrollHeight;
  }

  function renderBridgeMateTopicPrompts(questions = []) {
    const list = $("#bridgemate-topic-prompts");
    if (!list) return;
    const prompts = questions.slice(0, 5).map(item => item.question);
    list.innerHTML = prompts.length
      ? prompts.map(prompt => `<button type="button" class="bridgemate-prompt" data-bridge-prompt="${esc(prompt)}">${esc(prompt)}</button>`).join("")
      : '<p class="bridgemate-topic-empty">No reviewed prompts are available in this topic yet.</p>';
  }

  async function loadBridgeMateTopic(category = "") {
    bridgeMateCurrentTopic = category;
    const list = $("#bridgemate-topic-prompts");
    if (list) list.innerHTML = '<p class="bridgemate-topic-empty">Loading reviewed prompts…</p>';
    try {
      const path = category ? `/chatbot/questions?category=${encodeURIComponent(category)}` : "/chatbot/questions";
      const data = await api(path);
      renderBridgeMateTopicPrompts(data.questions || []);
      const filter = $("#bridgemate-topic-filter");
      filter?.querySelectorAll("[data-bridge-category]").forEach(button => {
        const selected = button.dataset.bridgeCategory === category;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", String(selected));
      });
    } catch (error) {
      if (list) list.innerHTML = `<p class="bridgemate-topic-empty is-error">${esc(error.message || "Topics could not be loaded.")}</p>`;
    }
  }

  async function sendBridgeMateQuestion(rawQuery) {
    const input = $("#bridgemate-input");
    const query = String(rawQuery ?? input?.value ?? "").trim();
    if (!query || bridgeMateBusy || query.length > 300) return;
    bridgeMateHistory.push({ role: "user", text: query });
    if (input) input.value = "";
    bridgeMateBusy = true;
    const submit = $("#bridgemate-send");
    const status = $("#bridgemate-status");
    if (submit) submit.disabled = true;
    if (status) status.innerHTML = '<span class="bridgemate-typing" aria-label="BridgeMate is searching"><i></i><i></i><i></i></span> Checking reviewed FAQs…';
    renderBridgeMateMessages();
    try {
      const result = await api("/chatbot/ask", { method: "POST", body: JSON.stringify({ query }) });
      bridgeMateHistory.push({
        role: "assistant", text: result.answer || "I could not find a reviewed answer.",
        title: result.title, matched: result.matched, category_label: result.category_label,
        mode: result.mode,
        quick_prompts: result.quick_prompts || [],
      });
    } catch (error) {
      bridgeMateHistory.push({ role: "assistant", title: "BridgeMate could not answer this question.", text: error.message || "Please try again.", error: true, retryQuery: query, quick_prompts: [query] });
    } finally {
      bridgeMateBusy = false;
      if (submit) submit.disabled = false;
      if (status) status.textContent = "FAQ is checked first; AI replies are labelled. Verify current opportunities from official sources.";
      renderBridgeMateMessages();
      input?.focus({ preventScroll: true });
    }
  }

  async function mountBridgeMate() {
    const root = $("#bridgemate-root");
    if (!root) return;
    root.innerHTML = "";
    bridgeMateOpen = false;
    bridgeMateBusy = false;
    bridgeMateHistory = [];
    bridgeMateCategories = [];
    if (!currentUser || currentUser.role !== "user") return;

    root.innerHTML = `
      <button id="bridgemate-launcher" class="bridgemate-launcher" type="button" aria-label="Open SkillGuide assistant" aria-expanded="false" aria-controls="bridgemate-panel"><img class="skillguide-launcher-logo" src="/skillguide-logo-transparent.png" alt="" /></button>
      <section id="bridgemate-panel" class="bridgemate-panel" role="dialog" aria-label="SkillGuide — Your Career & Learning Assistant" aria-modal="false" hidden>
        <header class="bridgemate-header"><div class="skillguide-heading"><b>SkillGuide</b><small>Your Career &amp; Learning Assistant</small></div><button id="bridgemate-close" type="button" class="icon-btn" aria-label="Close SkillGuide"><i data-lucide="x"></i></button></header>
        <div class="bridgemate-topics"><div class="bridgemate-topics-heading"><b>Browse a topic</b><small>Reviewed guidance only</small></div><div id="bridgemate-topic-filter" class="bridgemate-topic-filter"><button type="button" class="bridgemate-topic is-selected" data-bridge-category="" aria-pressed="true">All topics</button></div><div id="bridgemate-topic-prompts" class="bridgemate-topic-prompts"><p class="bridgemate-topic-empty">Loading suggestions…</p></div></div>
        <div id="bridgemate-messages" class="bridgemate-messages" role="log" aria-live="polite"><article class="bridgemate-welcome"><b>How can I help with your career?</b><p>I’ll check reviewed SkillBridge FAQs first. AI fallback gives general guidance and cannot verify live openings.</p></article></div>
        <p id="bridgemate-status" class="bridgemate-status" role="status">Reviewed FAQ first; AI replies are labelled.</p>
        <form id="bridgemate-form" class="bridgemate-form"><label class="sr-only" for="bridgemate-input">Ask a career question</label><input id="bridgemate-input" type="text" maxlength="300" autocomplete="off" placeholder="Ask about skills, roadmaps, interviews…" required /><button id="bridgemate-send" type="submit" aria-label="Send question"><i data-lucide="arrow-up"></i></button></form>
        <footer class="bridgemate-footer"><span>AI fallback sends only your question. Avoid personal or confidential details.</span><button id="bridgemate-clear" type="button">Clear chat</button></footer>
      </section>`;
    refreshIcons();

    const launcher = $("#bridgemate-launcher");
    const panel = $("#bridgemate-panel");
    launcher.onclick = () => {
      bridgeMateOpen = !bridgeMateOpen;
      panel.hidden = !bridgeMateOpen;
      launcher.setAttribute("aria-expanded", String(bridgeMateOpen));
      if (bridgeMateOpen) $("#bridgemate-input")?.focus({ preventScroll: true });
    };
    $("#bridgemate-close").onclick = () => {
      bridgeMateOpen = false;
      panel.hidden = true;
      launcher.setAttribute("aria-expanded", "false");
      launcher.focus({ preventScroll: true });
    };
    $("#bridgemate-form").onsubmit = event => {
      event.preventDefault();
      sendBridgeMateQuestion();
    };
    $("#bridgemate-clear").onclick = () => {
      bridgeMateHistory = [];
      renderBridgeMateMessages();
    };
    root.onclick = event => {
      const retry = event.target.closest("[data-bridge-retry]");
      if (retry) { sendBridgeMateQuestion(retry.dataset.bridgeRetry); return; }
      const prompt = event.target.closest("[data-bridge-prompt]");
      if (prompt) { sendBridgeMateQuestion(prompt.dataset.bridgePrompt); return; }
      const category = event.target.closest("[data-bridge-category]");
      if (category) loadBridgeMateTopic(category.dataset.bridgeCategory || "");
    };

    try {
      const [categoryData, questionData] = await Promise.all([api("/chatbot/categories"), api("/chatbot/questions")]);
      bridgeMateCategories = categoryData.categories || [];
      const filter = $("#bridgemate-topic-filter");
      filter.innerHTML = `<button type="button" class="bridgemate-topic is-selected" data-bridge-category="" aria-pressed="true">All topics</button>${bridgeMateCategories.map(item => `<button type="button" class="bridgemate-topic" data-bridge-category="${esc(item.category)}" aria-pressed="false">${esc(item.category_label)}</button>`).join("")}`;
      renderBridgeMateTopicPrompts(questionData.questions || []);
      if (questionData.quick_prompts?.length) {
        bridgeMateHistory[0] = { role: "assistant", text: "Choose a suggested question or type your own.", quick_prompts: questionData.quick_prompts.slice(0, 4) };
        renderBridgeMateMessages();
      }
      refreshIcons();
    } catch (error) {
      const list = $("#bridgemate-topic-prompts");
      if (list) list.innerHTML = `<p class="bridgemate-topic-empty is-error">${esc(error.message || "FAQ topics are unavailable.")}</p>`;
    }
  }

  function unmountBridgeMate() {
    const root = $("#bridgemate-root");
    if (root) root.innerHTML = "";
    bridgeMateOpen = false;
    bridgeMateBusy = false;
    bridgeMateCategories = [];
    bridgeMateHistory = [];
    bridgeMateCurrentTopic = "";
  }

  // --------------------------------------------------------------------------
  // Navigation & View Router
  // --------------------------------------------------------------------------
  function renderSidebarNav() {
    const nav = $("#sidebar-nav");
    let links = [];

    if (currentUser.role === "user") {
      links = [
        { view: "dashboard", icon: "layout-dashboard", label: "Dashboard" },
        { view: "analytics", icon: "chart-no-axes-combined", label: "Analytics & Insights" },
        { view: "recommendations", icon: "sparkles", label: "Skill Matches" },
        { view: "jobs", icon: "briefcase", label: "Browse Jobs" },
        { view: "hackathons", icon: "trophy", label: "Browse Hackathons" },
        { view: "saved-jobs", icon: "bookmark", label: "Saved Opportunities" },
        { view: "applications", icon: "clipboard-check", label: "My Applications" },
        { view: "profile", icon: "user", label: "My Profile & CV" }
      ];
    } else if (currentUser.role === "recruiter") {
      links = [
        { view: "dashboard", icon: "layout-dashboard", label: "Dashboard" },
        { view: "analytics", icon: "chart-no-axes-combined", label: "Analytics & Insights" },
        { view: "post-job", icon: "plus-circle", label: "Post New Opening" },
        { view: "recruiter-jobs", icon: "layers", label: "Company Openings" },
        { view: "recruiter-applicants", icon: "users", label: "Candidate Applicants" },
        { view: "company-profile", icon: "building", label: "Company Profile" }
      ];
    } else if (currentUser.role === "developer") {
      links = [
        { view: "dashboard", icon: "shield-check", label: "Developer Overview" },
        { view: "analytics", icon: "chart-no-axes-combined", label: "Analytics & Insights" },
        { view: "dev-pending", icon: "clock", label: "Pending Approvals" },
        { view: "dev-links", icon: "link-2", label: "Recruiter Link Requests" },
        { view: "dev-companies", icon: "building-2", label: "All Companies" },
        { view: "dev-users", icon: "users-round", label: "User Accounts Audit" },
        { view: "dev-jobs", icon: "briefcase", label: "Job Openings Audit" },
        { view: "dev-applications", icon: "file-text", label: "Applications Audit" }
      ];
    }

    nav.innerHTML = links.map(link => `
      <button class="nav-link ${currentView === link.view ? 'active' : ''}" data-view="${link.view}" aria-current="${currentView === link.view ? 'page' : 'false'}">
        <i data-lucide="${link.icon}"></i>
        <span>${link.label}</span>
      </button>
    `).join("");

    nav.querySelectorAll("[data-view]").forEach(btn => {
      btn.addEventListener("click", () => {
        const v = btn.dataset.view;
        $("#sidebar").classList.remove("open");
        loadView(v);
      });
    });

    refreshIcons();
  }

  function loadView(viewName, initialSearch = "") {
    const allowedViews = currentUser && ROLE_VIEWS[currentUser.role];
    if (!allowedViews) {
      showLandingScreen();
      return;
    }
    if (!allowedViews.has(viewName)) viewName = "dashboard";
    currentView = viewName;
    renderSidebarNav();
    const content = $("#main-content");
    content.innerHTML = `<div class="loading-state" role="status"><span class="button-spinner" aria-hidden="true"></span><p>Loading your workspace…</p></div>`;
    refreshIcons();

    if (currentUser.role === "user") {
      if (viewName === "dashboard") renderCandidateDashboard();
      else if (viewName === "analytics") renderAnalytics();
      else if (viewName === "recommendations") renderCandidateRecommendations();
      else if (viewName === "jobs") renderBrowseJobs(initialSearch);
      else if (viewName === "hackathons") renderBrowseHackathons();
      else if (viewName === "saved-jobs") renderSavedOpportunities();
      else if (viewName === "applications") renderCandidateApplications();
      else if (viewName === "profile") renderCandidateProfile();
    } else if (currentUser.role === "recruiter") {
      if (viewName === "dashboard") renderRecruiterDashboard();
      else if (viewName === "analytics") renderAnalytics();
      else if (viewName === "post-job") renderPostJobForm();
      else if (viewName === "recruiter-jobs") renderRecruiterJobsList();
      else if (viewName === "recruiter-applicants") renderRecruiterApplicants();
      else if (viewName === "company-profile") renderRecruiterCompanyProfile();
    } else if (currentUser.role === "developer") {
      if (viewName === "dashboard") renderDeveloperDashboard();
      else if (viewName === "analytics") renderAnalytics();
      else if (viewName === "dev-pending") renderDeveloperPendingCompanies();
      else if (viewName === "dev-links") renderDeveloperLinkRequests();
      else if (viewName === "dev-companies") renderDeveloperAllCompanies();
      else if (viewName === "dev-users") renderDeveloperUsersAudit();
      else if (viewName === "dev-jobs") renderDeveloperJobsAudit();
      else if (viewName === "dev-opportunity-form") renderDeveloperOpportunityForm();
      else if (viewName === "dev-applications") renderDeveloperApplicationsAudit();
    }
  }

  // --------------------------------------------------------------------------
  // CANDIDATE VIEWS
  // --------------------------------------------------------------------------
  async function renderCandidateDashboard() {
    try {
      const [profileData, jobsData, appsData, recData, savedData] = await Promise.all([
        api("/candidate/profile"),
        api("/jobs").catch(error => ({ _loadError: error })),
        api("/candidate/applications").catch(error => ({ _loadError: error })),
        api("/candidate/recommendations").catch(error => ({ _loadError: error })),
        api("/candidate/saved-jobs").catch(error => ({ _loadError: error }))
      ]);
      const profile = profileData && typeof profileData === "object" ? profileData : {};
      const jobsFailed = !jobsData || Boolean(jobsData._loadError);
      const recommendationsFailed = !recData || Boolean(recData._loadError);
      const savedFailed = !savedData || Boolean(savedData._loadError);
      savedJobsCache = Array.isArray(savedData?.saved_jobs) ? savedData.saved_jobs : [];
      savedJobIds = new Set(savedJobsCache.map(job => Number(job.id)));

      const skillsCount = Array.isArray(profile.skills) ? profile.skills.length : 0;
      const applicationsFailed = !appsData || Boolean(appsData._loadError);
      const appsCount = applicationsFailed ? null : (Array.isArray(appsData?.applications) ? appsData.applications.length : 0);
      const jobs = Array.isArray(jobsData?.jobs) ? jobsData.jobs : [];
      const recommendations = Array.isArray(recData?.recommendations) ? recData.recommendations : [];
      const savedCount = savedJobsCache.length;
      const totalJobs = jobsFailed ? null : jobs.length;
      const topRec = recommendations.slice(0, 3);
      const completion = candidateProfileCompletion(profile);
      const applications = applicationsFailed ? null : (Array.isArray(appsData?.applications) ? appsData.applications : []);
      const statusCounts = (applications || []).reduce((counts, application) => {
        const status = application.current_status || "submitted";
        counts[status] = (counts[status] || 0) + 1;
        return counts;
      }, {});

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>Welcome back, ${esc(currentUser.name || currentUser.username)}</h1>
            <p>Your skills, opportunities, and next steps—all in one place.</p>
          </div>
          <div class="heading-actions">
            <button class="btn btn-primary" onclick="window.jobMatcher.loadView('recommendations')">
              <i data-lucide="sparkles"></i> View your matches
            </button>
            <button class="btn btn-outline" onclick="window.jobMatcher.loadView('profile')">
              <i data-lucide="user"></i> Edit Profile & CV
            </button>
          </div>
        </div>

        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-icon blue"><i data-lucide="cpu"></i></div>
            <div>
              <span class="metric-label">PROFILE SKILLS</span>
              <div class="metric-value">${skillsCount}</div>
              <span class="metric-foot">In your technical profile</span>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-icon green"><i data-lucide="clipboard-check"></i></div>
            <div>
              <span class="metric-label">APPLICATIONS</span>
              <div class="metric-value">${appsCount === null ? "—" : appsCount}</div>
              <span class="metric-foot">${applicationsFailed ? "Application data unavailable" : "Submitted to recruiters"}</span>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-icon gold"><i data-lucide="briefcase"></i></div>
            <div>
              <span class="metric-label">ACTIVE OPENINGS</span>
              <div class="metric-value">${totalJobs === null ? "—" : totalJobs}</div>
              <span class="metric-foot">${jobsFailed ? "Opportunity data unavailable" : "Accepting applications"}</span>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-icon purple"><i data-lucide="bookmark"></i></div>
            <div>
              <span class="metric-label">SAVED OPPORTUNITIES</span>
              <div class="metric-value" data-saved-count>${savedFailed ? "—" : savedCount}</div>
              <span class="metric-foot">${savedFailed ? "Saved items unavailable" : "Opportunities you want to revisit"}</span>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-icon purple"><i data-lucide="file-text"></i></div>
            <div>
              <span class="metric-label">SAVED RESUMES</span>
              <div class="metric-value">${Array.isArray(profile.resumes) ? profile.resumes.length : 0}</div>
              <span class="metric-foot">Uploaded CV files</span>
            </div>
          </div>
        </div>

        <div class="panel" style="margin-bottom:20px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
            <div style="flex:1;min-width:240px;">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                <h3 style="margin:0;">Profile completeness</h3><b>${completion.percentage}%</b>
              </div>
              <progress value="${completion.percentage}" max="100" style="width:100%;margin:10px 0 4px;"></progress>
              <p class="muted" style="margin:0;">${completion.missing.length ? `Next steps: ${completion.missing.slice(0, 3).map(esc).join(", ")}` : "Your key profile sections are complete."}</p>
            </div>
            <button class="btn btn-outline" onclick="window.jobMatcher.loadView('profile')">Update profile & CV</button>
          </div>
        </div>

        <div class="panel saved-opportunities-preview" style="margin-bottom:20px;">
          <div class="panel-head">
            <div><h3>Saved Opportunities</h3><p>${savedCount ? `${savedCount} opportunit${savedCount === 1 ? 'y' : 'ies'} saved for later` : 'Keep interesting opportunities close at hand'}</p></div>
            <button class="btn btn-soft btn-sm" onclick="window.jobMatcher.loadView('saved-jobs')">View saved <i data-lucide="arrow-right"></i></button>
          </div>
          ${savedFailed ? `<p role="alert" class="muted">Saved opportunities could not be loaded: ${esc(savedData?._loadError?.message||"Please retry from Saved Opportunities.")}</p>` : savedCount ? `<div class="saved-preview-list">${savedJobsCache.slice(0, 3).map(job => `<div class="saved-preview-item"><div><b>${esc(job.title)}</b><small>${esc(job.company_name)} · ${esc(job.lifecycle_status)}</small></div><button class="btn btn-outline btn-sm" onclick="window.jobMatcher.openSavedJobDetails(${job.id})">Details</button></div>`).join('')}</div>` : '<p class="muted">Save an opportunity from Browse Jobs or Skill Matches to see it here.</p>'}
        </div>

        <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:20px;">
          <!-- Recommendations Preview -->
          <div class="panel">
            <div class="panel-head">
              <div>
                <h3>Recommended Opportunities</h3>
                <p>Top algorithmic matches based on your skills and preferences</p>
              </div>
              <button class="btn btn-soft btn-sm" onclick="window.jobMatcher.loadView('recommendations')">
                View All Matches <i data-lucide="arrow-right"></i>
              </button>
            </div>
            ${recommendationsFailed ? `<p role="alert" class="muted">Recommendations could not be loaded: ${esc(recData?._loadError?.message||"Please retry from Skill Matches.")}</p>` : topRec.length === 0 ? `
              <p class="muted" style="text-align:center;padding:25px;">No published job recommendations available yet. Try adding more skills to your profile!</p>
            ` : `
              <div style="display:grid;gap:12px;">
                ${topRec.map(j => `
                  <div style="border:1px solid #edf0f5;border-radius:12px;padding:14px;display:flex;align-items:center;justify-content:space-between;gap:14px;">
                    <div>
                      <b style="font-size:13px;display:block;margin-bottom:3px;">${esc(j.title)}</b>
                      <span style="font-size:11px;color:#78869c;">${esc(j.company_name)} · ${esc(j.work_mode)} · ${esc(j.location)}</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;">
                      <span class="match-score-pill ${j.match_percentage >= 70 ? 'high' : 'medium'}">
                        ${j.match_percentage == null ? 'Skill score unavailable' : `${j.match_percentage}% Match`}
                      </span>
                      ${renderSaveButton(j.id)}
                      ${renderApplicationAction(j, 'Apply') }
                    </div>
                  </div>
                `).join("")}
              </div>
            `}
          </div>

          <!-- Recent Applications -->
          <div class="panel">
            <div class="panel-head">
              <div>
                <h3>Recent Applications</h3>
                <p>Status progression from recruiters</p>
              </div>
              <button class="btn btn-soft btn-sm" onclick="window.jobMatcher.loadView('applications')">
                View All
              </button>
            </div>
            ${applicationsFailed ? `
              <div role="alert" style="padding:14px;border:1px solid #f0caca;border-radius:10px;background:#fff7f7;color:#a04e4e;font-size:12px;">Applications could not be loaded: ${esc(appsData._loadError.message || "Please try again.")} <button class="btn btn-outline btn-sm" onclick="window.jobMatcher.loadView('dashboard')">Retry</button></div>
            ` : appsCount ? `
              <div class="skill-chips" style="margin-bottom:8px;">
                ${Object.entries(statusCounts).map(([status, count]) => `<span class="skill-chip">${applicationStatusLabel(status)}: ${count}</span>`).join("")}
              </div>
            ` : ""}
            ${!applicationsFailed && appsCount === 0 ? `
              <p class="muted" style="text-align:center;padding:25px;">You have not applied for any jobs yet. Browse openings to start!</p>
            ` : !applicationsFailed ? `
              <div style="display:grid;gap:10px;">
                ${applications.slice(0, 4).map(a => `
                  <div style="padding:10px 0;border-bottom:1px solid #f0f3f7;display:flex;align-items:center;justify-content:space-between;">
                    <div>
                      <b style="font-size:12px;display:block;">${esc(a.job_title)}</b>
                      <small style="color:#8a96a9;">${esc(a.company_name)} · Applied ${formatDate(a.applied_at)}</small>
                    </div>
                    <span class="status-pill ${esc(a.current_status)}">${applicationStatusLabel(a.current_status)}</span>
                  </div>
                `).join("")}
              </div>
            ` : ""}
          </div>
        </div>
      `;
      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load dashboard: ${esc(e.message)}</p></div>`;
    }
  }

  async function renderCandidateRecommendations() {
    try {
      const [data, savedData] = await Promise.all([api("/candidate/recommendations"), api("/candidate/saved-jobs")]);
      const recs = data.recommendations || [];
      savedJobsCache = savedData.saved_jobs || [];
      savedJobIds = new Set(savedJobsCache.map(job => Number(job.id)));

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>Smart Relational Job Recommendations</h1>
            <p>Matched using your profile skills and the requirements employers provide.</p>
          </div>
        </div>

        <div style="background:#eef4ff;border:1px solid #c9dafa;border-radius:12px;padding:12px 18px;margin-bottom:20px;display:flex;align-items:center;gap:10px;font-size:12px;color:#28488a;">
          <i data-lucide="info" style="width:18px;flex-shrink:0;"></i>
          <span><b>Transparent SQL Matching:</b> Required skills count four times as much as optional skills, and skills count only when your proficiency meets the opportunity minimum.</span>
        </div>

        ${recs.length === 0 ? `
          <div class="panel" style="text-align:center;padding:50px;">
            <i data-lucide="compass" style="width:40px;height:40px;color:#9aa7bc;margin-bottom:12px;"></i>
            <h3>No Recommended Openings Found</h3>
            <p class="muted">Ensure you have added technical skills to your profile and that recruiters have published active jobs.</p>
            <button class="btn btn-primary" onclick="window.jobMatcher.loadView('profile')">Manage Profile Skills</button>
          </div>
        ` : `
          <div class="job-grid">
            ${recs.map(job => {
              const skillsList = job.skills_breakdown || [];
              const matchClass = job.match_percentage >= 75 ? "high" : job.match_percentage >= 50 ? "medium" : "low";

              return `
                <div class="job-card">
                  <div class="job-card-head">
                    <div class="company-badge">${esc(job.company_name.substring(0, 2).toUpperCase())}</div>
                    <div class="job-card-title" style="flex:1;">
                      <h3>${esc(job.title)}</h3>
                      <p>${esc(job.company_name)} · ${esc(job.industry || (job.owner_type==='ADMIN'?'Platform curated':'Tech'))}</p>
                    </div>
                  <span class="match-score-pill ${matchClass}">
                      <i data-lucide="sparkles" style="width:12px;"></i> ${job.match_percentage == null ? 'Skill score unavailable' : `${job.match_percentage}% skill overlap`}
                    </span>
                  </div>

                  ${renderSourceBadge(job)}

                  <div class="job-meta-row">
                    <span><i data-lucide="map-pin"></i> ${esc(job.location)}</span>
                    <span><i data-lucide="briefcase"></i> ${esc(job.opportunity_type||job.job_type||'Opportunity')}</span>
                    <span><i data-lucide="home"></i> ${esc(job.work_mode || 'Work mode not specified')}</span>
                    <span><i data-lucide="calendar"></i> ${esc(opportunityDeadlineLabel(job))}</span>
                  </div>

                  <small class="muted">${esc(opportunityBranchLabel(job))}</small>

                  <p style="font-size:11px;color:#55637a;line-height:1.6;margin:0;">
                    ${esc((job.description || '').length > 150 ? job.description.slice(0, 150) + '...' : (job.description || 'No description provided.'))}
                  </p>

                  <!-- Existing weighted score remains separate from required-only skill gap. -->
                  <div>
                    <span style="font-size:10px;font-weight:700;color:#6b7c97;display:block;margin-bottom:6px;">
                      SKILLS OVERLAP (${job.matching_skills_count} OF ${job.total_required_skills} MATCHED):
                    </span>
                    <div class="skill-chips">
                      ${skillsList.map(s => `
                        <span class="skill-chip ${s.matched ? 'match' : 'missing'}">
                          <i data-lucide="${s.matched ? 'check' : 'x'}" style="width:11px;"></i>
                          ${esc(s.name)}
                        </span>
                      `).join("")}
                    </div>
                  </div>
                  ${renderSkillGapHTML(job)}

                  <!-- Preferences Alignment -->
                  <div style="font-size:10px;color:#637591;display:flex;gap:12px;flex-wrap:wrap;border-top:1px solid #f0f3f7;padding-top:10px;">
                    ${job.work_mode_match ? `<span style="color:#137351;"><i data-lucide="check-circle" style="width:12px;"></i> Matches your Work Mode preference</span>` : ''}
                    ${job.location_match ? `<span style="color:#137351;"><i data-lucide="check-circle" style="width:12px;"></i> Matches your Location preference</span>` : ''}
                    ${opportunityCompensationLabel(job) ? `<span><i data-lucide="credit-card"></i> ${esc(opportunityCompensationLabel(job))}</span>` : ''}
                  </div>

                  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:auto;padding-top:8px;">
                    ${renderSaveButton(job.id)}
                    <button class="btn btn-outline" onclick="window.jobMatcher.openJobDetails(${job.id})"><i data-lucide="eye"></i> Details</button>
                    ${renderApplicationAction(job, 'Apply Now')}
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        `}
      `;
      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load recommendations: ${esc(e.message)}</p></div>`;
    }
  }

  async function renderBrowseJobs(initialSearch = "", initialCategory = "") {
    try {
      const [data, savedData, profileData] = await Promise.all([api("/jobs"), api("/candidate/saved-jobs"), api("/candidate/profile")]);
      const jobs = data.jobs || [];
      const candidateBranch = (profileData.education || []).find(item => item.field_of_study)?.field_of_study || null;
      savedJobsCache = savedData.saved_jobs || [];
      savedJobIds = new Set(savedJobsCache.map(job => Number(job.id)));

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>${initialCategory === "hackathon" ? "Browse Hackathons" : "Discover Opportunities"}</h1>
            <p>${initialCategory === "hackathon" ? "Find current, admin-curated hackathons and open the official registration page." : "Explore active opportunities that fit your interests and experience."}</p>
          </div>
        </div>

        <div class="panel" style="margin-bottom:20px;padding:14px 18px;">
          <div style="display:flex;gap:10px;flex-wrap:wrap;">
            <input id="job-search-input" class="form-input" style="flex:1;min-width:220px;" placeholder="Search by title, skills, or company..." value="${esc(initialSearch)}" />
            <select id="job-eligibility-filter" class="form-select" style="min-width:190px;">
              <option value="my" ${candidateBranch ? 'selected' : ''}>My eligible opportunities</option>
              <option value="all" ${!candidateBranch ? 'selected' : ''}>All active opportunities${candidateBranch ? '' : ' (branch not set)'}</option>
            </select>
            <input id="job-branch-filter" class="form-input" style="min-width:150px;" placeholder="Branch filter (e.g. ECE)" aria-label="Filter by eligible branch" />
            <input id="job-skill-filter" class="form-input" style="min-width:150px;" placeholder="Required skill" />
            <input id="job-location-filter" class="form-input" style="min-width:150px;" placeholder="Location" />
            <input id="job-deadline-filter" class="form-input" type="date" aria-label="Deadline on or before" title="Deadline on or before" style="min-width:155px;" />
            <select id="job-source-filter" class="form-select" style="min-width:150px;">
              <option value="">All Sources</option><option value="ADMIN">Platform curated</option><option value="RECRUITER">Recruiter</option><option value="ADMIN_CURATED_VERIFIED">Verified official source</option><option value="ADMIN_CURATED_PROGRAM">Curated program</option>
            </select>
            <select id="job-type-filter" class="form-select" style="min-width:140px;">
              <option value="All">All Types</option>
              <option value="Full-time">Full-time</option>
              <option value="Internship">Internship</option>
              <option value="Part-time">Part-time</option>
              <option value="Contract">Contract</option>
            </select>
            <select id="job-mode-filter" class="form-select" style="min-width:140px;">
              <option value="All">All Work Modes</option>
              <option value="Remote">Remote</option>
              <option value="Hybrid">Hybrid</option>
              <option value="On-site">On-site</option>
            </select>
            <select id="opp-category-filter" class="form-select" style="min-width:150px;">
              <option value="">All Categories</option><option value="internship">Internships</option><option value="hackathon">Hackathons</option><option value="project">Student Projects</option><option value="open_source">Open Source</option><option value="research">Research</option><option value="scholarship">Scholarships</option><option value="fellowship">Fellowships</option><option value="competition">Competitions</option><option value="workshop">Workshops</option><option value="developer_program">Developer Programs</option><option value="startup">Startups</option><option value="apprenticeship">Apprenticeships</option><option value="certification">Certifications</option><option value="government">Government</option><option value="psu">PSU</option><option value="gate">GATE</option><option value="training">Training</option><option value="job">Jobs</option>
            </select>
            <select id="opp-sort-filter" class="form-select" style="min-width:150px;"><option value="best">Best match</option><option value="recent">Recently added</option><option value="deadline">Deadline approaching</option><option value="compensation">Compensation</option></select>
            <button class="btn btn-primary" id="apply-job-filters-btn">
              <i data-lucide="filter"></i> Filter
            </button>
          </div>
        </div>

        ${candidateBranch ? `<p class="muted" style="margin:-8px 0 16px;">Using your education branch: <b>${esc(candidateBranch)}</b></p>` : `<p class="muted" style="margin:-8px 0 16px;">Your branch is not set. Showing opportunities with eligibility marked unknown where needed; add a branch to personalize the eligible filter.</p>`}

        <div id="jobs-cards-container" class="job-grid">
          ${renderJobCardsHTML(jobs)}
        </div>
      `;

      $("#apply-job-filters-btn").addEventListener("click", async e => {
        const button = e.currentTarget;
        button.disabled = true;
        const oldText = button.innerHTML;
        button.textContent = "Loading…";
        const s = $("#job-search-input").value;
        const t = $("#job-type-filter").value;
        const m = $("#job-mode-filter").value;
        const c = $("#opp-category-filter").value;
        const sort = $("#opp-sort-filter").value;
        const eligibility = $("#job-eligibility-filter").value;
        const branch = $("#job-branch-filter").value.trim();
        const skill = $("#job-skill-filter").value;
        const location = $("#job-location-filter").value;
        const deadline = $("#job-deadline-filter").value;
        const source = $("#job-source-filter").value;
        try {
          const filtered = await api(`/jobs?search=${encodeURIComponent(s)}&job_type=${encodeURIComponent(t)}&work_mode=${encodeURIComponent(m)}&category=${encodeURIComponent(c)}&location=${encodeURIComponent(location)}&sort=${encodeURIComponent(sort)}&eligibility=${encodeURIComponent(eligibility)}&branch=${encodeURIComponent(branch)}&skill=${encodeURIComponent(skill)}&deadline_before=${encodeURIComponent(deadline)}&source=${encodeURIComponent(source)}&page=1&limit=50`);
          $("#jobs-cards-container").innerHTML = renderJobCardsHTML(filtered.jobs || []);
          refreshIcons();
        } catch (err) { toast(err.message, true); }
        finally { button.disabled = false; button.innerHTML = oldText; }
      });

      if (initialCategory) { $("#opp-category-filter").value = initialCategory; $("#opp-sort-filter").value = "recent"; }
      if (initialSearch || initialCategory) $("#apply-job-filters-btn").click();

      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load jobs: ${esc(e.message)}</p></div>`;
    }
  }

  async function renderBrowseHackathons(filters = {}) {
    const content = $("#main-content");
    content.innerHTML = `<div class="loading-state" role="status"><span class="button-spinner"></span><p>Finding hackathons…</p></div>`;
    const query = new URLSearchParams({page:String(filters.page||1),limit:"12",sort:filters.sort||"upcoming"});
    for (const key of ["search","location","mode","status","theme","participation"]) if(filters[key]) query.set(key,filters[key]);
    try {
      const [data,savedData] = await Promise.all([api(`/jobs/hackathons?${query}`),api("/candidate/saved-jobs")]);
      const events = data.hackathons || [];
      savedJobsCache = savedData.saved_jobs || [];
      savedJobIds = new Set(savedJobsCache.map(item=>Number(item.id)));
      const summary=data.summary||{};
      content.innerHTML=`<div class="page-heading"><div><h1>Discover Hackathons</h1><p>Discover competitions, build innovative projects, collaborate with developers, and compete for exciting prizes.</p><small class="muted">${Number(summary.open)||0} with open registration · ${Number(summary.online)||0} online</small></div></div>
        <form id="hackathon-filters" class="panel" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px;padding:14px">
          <input class="form-input" name="search" placeholder="Hackathon, organizer, theme" value="${esc(filters.search||'')}">
          <input class="form-input" name="location" placeholder="City or location" value="${esc(filters.location||'')}">
          <select class="form-select" name="mode"><option value="">Any mode</option>${['Online','Offline','Hybrid'].map(x=>`<option ${filters.mode===x?'selected':''}>${x}</option>`).join('')}</select>
          <select class="form-select" name="status"><option value="">Any event status</option>${[['upcoming','Upcoming'],['ongoing','Ongoing'],['completed','Completed'],['registration_open','Registration open'],['closing_soon','Closing soon'],['registration_closed','Registration closed']].map(([v,l])=>`<option value="${v}" ${filters.status===v?'selected':''}>${l}</option>`).join('')}</select>
          <input class="form-input" name="theme" placeholder="Theme or technology" value="${esc(filters.theme||'')}">
          <select class="form-select" name="participation"><option value="">Individual or team</option><option value="individual" ${filters.participation==='individual'?'selected':''}>Individual allowed</option><option value="team" ${filters.participation==='team'?'selected':''}>Team event</option></select>
          <select class="form-select" name="sort"><option value="upcoming" ${!filters.sort||filters.sort==='upcoming'?'selected':''}>Upcoming</option><option value="deadline" ${filters.sort==='deadline'?'selected':''}>Registration closing</option><option value="recent" ${filters.sort==='recent'?'selected':''}>Recently added</option></select>
          <button class="btn btn-primary" type="submit">Search</button><button class="btn btn-outline" type="reset">Clear filters</button>
        </form>
        <div class="hackathon-grid">${events.length?events.map(renderHackathonCard).join(''):`<div class="panel hackathon-empty"><h3>${filters.search||filters.location||filters.mode||filters.status||filters.theme||filters.participation?'No hackathons match your current filters.':'No hackathons available at the moment.'}</h3><p class="muted">${filters.search||filters.location||filters.mode||filters.status||filters.theme||filters.participation?'Clear filters or try a different search.':'Check back soon for new competitions and events.'}</p>${filters.search||filters.location||filters.mode||filters.status||filters.theme||filters.participation?'<button class="btn btn-outline" id="hackathon-clear">Clear filters</button>':''}<button class="btn btn-soft" id="hackathon-retry">Refresh</button></div>`}</div>
        ${data.has_more?`<div class="hackathon-pagination"><button class="btn btn-outline" id="hackathon-more">Load more</button></div>`:''}`;
      $('#hackathon-filters').addEventListener('submit',e=>{e.preventDefault();const fd=new FormData(e.currentTarget);renderBrowseHackathons(Object.fromEntries(fd.entries()));});
      $('#hackathon-filters').addEventListener('reset',()=>setTimeout(()=>renderBrowseHackathons(),0));
      $('#hackathon-clear')?.addEventListener('click',()=>renderBrowseHackathons()); $('#hackathon-retry')?.addEventListener('click',()=>renderBrowseHackathons(filters));
      $('#hackathon-more')?.addEventListener('click',()=>renderBrowseHackathons({...filters,page:(filters.page||1)+1}));
      refreshIcons();
    } catch(error) {
      content.innerHTML=`<div class="panel hackathon-empty"><h3>Hackathons could not be loaded</h3><p class="muted">${esc(error.message)}</p><button class="btn btn-outline" id="hackathon-retry">Try again</button></div>`;
      $('#hackathon-retry').addEventListener('click',()=>renderBrowseHackathons(filters));
    }
  }

  function renderHackathonCard(event) {
    const d=event.hackathon_details||{}; const today=new Date().toISOString().slice(0,10);
    const deadline=event.deadline||''; const start=d.event_start_date||event.start_date||''; const end=d.event_end_date||start;
    const registration=deadline&&deadline<today?'Registration Closed':deadline&&deadline<=new Date(Date.now()+7*86400000).toISOString().slice(0,10)?'Closing Soon':'Registration Open';
    const tags=[d.themes,d.tracks,d.technologies].filter(Boolean).join(',').split(',').map(t=>t.trim()).filter(Boolean);
    const location=[d.venue,d.city,d.state,d.country].filter(Boolean).join(', ')||event.location||'';
    const job={...event,company_name:event.organizer_name,application_mode:'external',application_url:event.application_url,branch_eligibility:'all_branches'};
    return `<article class="hackathon-card"><div class="hackathon-cover" ${d.banner_url?`style="background-image:url('${esc(d.banner_url)}')"`:''}>${d.banner_url?'':`<span>${esc((d.themes||'Build · Learn · Compete').split(',')[0])}</span>`}<span class="hackathon-status ${registration==='Registration Open'?'open':registration==='Closing Soon'?'soon':'closed'}">${registration}</span></div>
      <div class="hackathon-card-body"><div class="hackathon-organizer">${d.organizer_logo_url?`<img src="${esc(d.organizer_logo_url)}" alt="" loading="lazy">`:''}<span>${esc(event.organizer_name||event.organization_name||'Organizer')}</span>${event.is_verified?'<b class="hackathon-verified" title="Source reviewed by SkillBridge">Verified</b>':''}</div>
      <h2>${esc(event.title)}</h2><p class="hackathon-description">${esc((event.description||'').slice(0,180))}${(event.description||'').length>180?'…':''}</p>
      <div class="hackathon-badges"><span>${esc(d.event_mode||event.work_mode||'Mode not specified')}</span>${location?`<span>${esc(location)}</span>`:''}</div>
      <div class="hackathon-facts">${start?`<span>📅 ${formatDate(start)}${end&&end!==start?` – ${formatDate(end)}`:''}</span>`:''}${d.prize_pool?`<span>🏆 ${esc(d.prize_pool)}</span>`:''}${d.team_size_min||d.team_size_max?`<span>👥 Team ${esc(d.team_size_min||'1')}–${esc(d.team_size_max||d.team_size_min||'')}</span>`:''}${deadline?`<span>⏳ Register by ${formatDate(deadline)}</span>`:''}</div>
      ${tags.length?`<div class="hackathon-tags">${tags.slice(0,6).map(t=>`<span>${esc(t)}</span>`).join('')}</div>`:''}
      <div class="hackathon-actions"><button class="btn btn-outline" onclick="window.jobMatcher.openJobDetails(${Number(event.id)})">View Details</button>${renderSaveButton(event.id)}${registration!=='Registration Closed'?renderApplicationAction(job,'Register Now'):''}</div></div></article>`;
  }

  function renderJobCardsHTML(jobs) {
    if (!jobs.length) {
      return `<div class="panel" style="grid-column:1/-1;text-align:center;padding:40px;"><p class="muted">No active opportunities match these filters. Try clearing a filter or check back later.</p></div>`;
    }

    return jobs.map(j => `
      <div class="job-card">
        <div class="job-card-head">
          <div class="company-badge">${esc((j.company_name || 'C').substring(0, 2).toUpperCase())}</div>
          <div class="job-card-title" style="flex:1;">
            <h3>${esc(j.title)}</h3>
            <p>${esc(j.company_name)}${j.industry ? ` · ${esc(j.industry)}` : ''}</p>
          </div>
          <span class="status-pill published">${esc(j.opportunity_type||j.job_type||'Opportunity')}</span>
        </div>
        ${renderSourceBadge(j)}
        ${j.is_sample ? '<span class="status-pill pending">SAMPLE OPPORTUNITY</span>' : ''}
        ${j.opportunity_category ? `<small class="muted">${esc(j.opportunity_category.replaceAll('_', ' '))}${j.experience_level ? ` · ${esc(j.experience_level)}` : ''}${j.paid_status && j.paid_status !== 'none' ? ` · ${esc(j.paid_status)}` : ''}</small>` : ''}
        ${j.match_percentage != null ? `<small class="muted">${Number(j.match_percentage)}% weighted skill overlap</small>` : ''}
        <small class="muted">${esc(opportunityBranchLabel(j))}</small>

        <div class="job-meta-row">
          <span><i data-lucide="map-pin"></i> ${esc(j.location)}</span>
          <span><i data-lucide="home"></i> ${esc(j.work_mode || 'Work mode not specified')}</span>
          ${(Number(j.salary_min)||Number(j.salary_max)) ? `<span><i data-lucide="credit-card"></i> ${formatCurrency(j.salary_min)} - ${formatCurrency(j.salary_max)}</span>` : ''}
          <span><i data-lucide="calendar"></i> ${esc(opportunityDeadlineLabel(j))}</span>
        </div>

        <p style="font-size:11px;color:#55637a;line-height:1.6;margin:0;">
          ${esc((j.description || '').length > 160 ? j.description.slice(0,160) + '…' : (j.description || 'No description provided.'))}
        </p>

        <div>
          <span style="font-size:10px;font-weight:700;color:#6b7c97;display:block;margin-bottom:6px;">REQUIRED SKILLS:</span>
          <div class="skill-chips">
            ${(j.skill_gap?.required_skills || (j.required_skills || []).filter(s => s.is_required !== false).map(s => ({name:s.name,matched:false}))).slice(0,4).map(s => `
              <span class="skill-chip ${s.matched ? 'match' : 'missing'}">
                ${esc(s.name)} <small style="color:#78869c;">(${esc(s.min_proficiency || 'Intermediate')})</small>
              </span>
            `).join("")}${(j.skill_gap?.total_required_skills || 0) > 4 ? `<span class="skill-chip">+${j.skill_gap.total_required_skills - 4} more required</span>` : ''}
          </div>
        </div>
        ${renderSkillGapHTML(j)}

        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:auto;border-top:1px solid #f0f3f7;padding-top:12px;">
          ${renderSaveButton(j.id)}
          <button class="btn btn-outline" onclick="window.jobMatcher.openJobDetails(${j.id})"><i data-lucide="eye"></i> Details</button>
          ${renderApplicationAction(j, 'Apply with SkillBridge')}
        </div>
      </div>
    `).join("");
  }

  function renderSkillGapHTML(opportunity) {
    const gap = opportunity?.skill_gap;
    if (!gap) return '';
    if (!gap.total_required_skills) {
      return `<div class="personalized-skill-gap"><b>Required-skill match</b><p class="muted">${esc(gap.skill_gap_message || 'No required skills listed.')}</p></div>`;
    }
    const percent = gap.required_skill_match_percentage == null ? '—' : `${Number(gap.required_skill_match_percentage)}%`;
    const hasSkills = Boolean(gap.candidate_has_skills);
    return `<section class="personalized-skill-gap" aria-label="Personalized required skill gap">
      <div class="skill-gap-heading"><b>Required-skill match</b><span class="status-pill ${hasSkills ? 'published' : 'pending'}">${percent}</span></div>
      ${gap.skill_gap_message ? `<p class="muted">${esc(gap.skill_gap_message)}</p>` : '<p class="muted">Required-skill match only; this is not a hiring or eligibility guarantee.</p>'}
      <div><b>Skills you already have</b><div class="skill-chips">${(gap.matched_required_skills || []).map(name => `<span class="skill-chip match">${esc(name)}</span>`).join('') || '<span class="muted">No required skills matched yet.</span>'}</div></div>
      <div><b>Skills Still Required</b><div class="skill-chips">${(gap.missing_required_skills || []).map(name => `<span class="skill-chip missing">${esc(name)}</span>`).join('') || '<span class="muted">None.</span>'}</div></div>
    </section>`;
  }

  function normalizeSkillForProfile(value) {
    const key = String(value || '').toLowerCase().replace(/[^a-z0-9+#.]/g, '');
    return ({ js: 'javascript', csharp: 'c#', cpp: 'c++', postgres: 'postgresql' })[key] || key;
  }

  function renderResumeReviewForm(extracted, profile, savedSkills, education) {
    const values = extracted.profile || {};
    const currentEdu = education?.[0] || {};
    const field = (name, label, type = 'text') => {
      const value = values[name] || profile[name] || '';
      const source = values[name] ? 'Extracted · review this value' : profile[name] ? 'From your saved profile' : 'Not found · enter manually if applicable';
      return `<div class="form-field ${['full_name','location','headline'].includes(name) ? 'full' : ''}"><label>${label}</label><input class="form-input" name="${name}" type="${type}" value="${esc(value)}"><small class="muted">${esc(source)}</small></div>`;
    };
    const skillMap = new Map();
    [...(savedSkills || []).map(s => s.skill_name), ...(extracted.skills || [])].filter(Boolean).forEach(name => {
      const key = normalizeSkillForProfile(name);
      if (key && !skillMap.has(key)) skillMap.set(key, name);
    });
    const skillNames = [...skillMap.values()];
    const firstEdu = extracted.education?.[0] || {};
    const eduValue = (key) => firstEdu[key] ?? currentEdu[key] ?? '';
    return `<form id="resume-review-form" class="form-grid" style="margin-top:14px">
      <div class="form-field full"><p class="muted">Review and edit every suggestion. Nothing is saved until you choose Save Profile & Preferences.</p></div>
      ${field('full_name','Full name')}${field('email','Email','email')}${field('phone','Phone')}${field('location','Location')}${field('headline','Professional headline')}
      <div class="form-field full"><label>Technical skills · comma or line separated</label><textarea class="form-textarea" name="skills" rows="3">${esc(skillNames.join(', '))}</textarea><small class="muted">This list combines saved profile skills and recognized PDF suggestions. Remove items you no longer want; new skills are saved at Beginner proficiency until you edit them.</small></div>
      <div class="form-field full"><b>Education suggestion</b><small class="muted">${firstEdu.degree || firstEdu.field_of_study || firstEdu.end_year ? 'Review the extracted education information and complete institution/degree if needed.' : 'No reliable education details were found. These fields are optional.'}</small></div>
      <div class="form-field"><label>College / institution</label><input class="form-input" name="education_institution" value="${esc(eduValue('institution'))}"></div>
      <div class="form-field"><label>Degree / course</label><input class="form-input" name="education_degree" value="${esc(eduValue('degree'))}"></div>
      <div class="form-field"><label>Branch / department</label><input class="form-input" name="education_field" value="${esc(eduValue('field_of_study'))}"></div>
      <div class="form-field"><label>Graduation year</label><input class="form-input" type="number" min="1950" max="2100" name="education_end_year" value="${esc(eduValue('end_year'))}"></div>
      <div class="form-field"><label>Start year</label><input class="form-input" type="number" min="1950" max="2100" name="education_start_year" value="${esc(eduValue('start_year'))}"></div>
      <div class="form-field"><label>Grade / CGPA (optional)</label><input class="form-input" name="education_grade" value="${esc(eduValue('grade'))}"></div>
      <div class="form-field full"><button type="submit" class="btn btn-primary"><i data-lucide="save"></i> Save Profile & Preferences</button></div>
    </form>`;
  }

  const pendingSavedJobIds = new Set();

  function renderSaveButton(jobId) {
    const saved = savedJobIds.has(Number(jobId));
    return `<button type="button" class="btn btn-outline btn-sm bookmark-button${saved ? ' is-saved' : ''}" data-save-job-id="${Number(jobId)}" aria-pressed="${saved}" aria-label="${saved ? 'Remove saved opportunity' : 'Save opportunity'}" onclick="window.jobMatcher.toggleSavedJob(${Number(jobId)})"><i data-lucide="${saved ? 'bookmark-check' : 'bookmark'}"></i><span>${saved ? 'Saved' : 'Save'}</span></button>`;
  }

  function renderApplicationAction(job, label = 'Apply') {
    if (job.application_mode === 'external' && job.application_url) {
      const externalLabel = job.branch_eligibility === 'not_eligible' ? 'Review official eligibility' : job.source_classification === 'ADMIN_CURATED_PROGRAM' ? 'Explore Program' : ['hackathon','competition','workshop'].includes(job.opportunity_category) ? 'Register externally' : 'View Official Opportunity';
      return `<a class="btn btn-primary" href="${esc(job.application_url)}" target="_blank" rel="noopener noreferrer" aria-label="${externalLabel}; opens the official site"><i data-lucide="external-link"></i> ${externalLabel}<small style="display:block;font-size:9px;opacity:.85;">Opens outside SkillBridge</small></a>`;
    }
    if (['not_eligible','eligibility_unknown','branch_unknown'].includes(job.branch_eligibility)) return `<span class="muted" title="Branch eligibility must be confirmed before applying">Check eligibility before applying</span>`;
    return `<button class="btn btn-primary" onclick="window.jobMatcher.openApplyModal(${Number(job.id)})"><i data-lucide="send"></i> ${esc(label)}</button>`;
  }

  async function toggleSavedJob(jobId) {
    const id = Number(jobId);
    if (!Number.isInteger(id) || id < 1 || pendingSavedJobIds.has(id)) return;
    const wasSaved = savedJobIds.has(id);
    const controls = $$(`[data-save-job-id="${id}"]`);
    pendingSavedJobIds.add(id);
    controls.forEach(button => {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.innerHTML = '<span class="button-spinner" aria-hidden="true"></span><span>Saving…</span>';
    });
    try {
      if (wasSaved) {
        await api(`/candidate/saved-jobs/${id}`, { method: 'DELETE' });
        savedJobIds.delete(id);
        savedJobsCache = savedJobsCache.filter(job => Number(job.id) !== id);
        toast('Opportunity removed from saved items.');
        if (currentView === 'saved-jobs') {
          closeModal();
          await renderSavedOpportunities();
          return;
        }
      } else {
        await api('/candidate/saved-jobs', { method: 'POST', body: JSON.stringify({ job_id: id }) });
        savedJobIds.add(id);
        toast('Opportunity saved for later.');
      }
      $$(`[data-save-job-id="${id}"]`).forEach(button => {
        const saved = savedJobIds.has(id);
        button.classList.toggle('is-saved', saved);
        button.setAttribute('aria-pressed', String(saved));
        button.setAttribute('aria-label', saved ? 'Remove saved opportunity' : 'Save opportunity');
        button.innerHTML = `<i data-lucide="${saved ? 'bookmark-check' : 'bookmark'}"></i><span>${saved ? 'Saved' : 'Save'}</span>`;
      });
      const count = document.querySelector('[data-saved-count]');
      if (count) count.textContent = savedJobIds.size;
      refreshIcons();
      if (currentView === 'dashboard') await renderCandidateDashboard();
    } catch (error) {
      toast(error.message || 'Unable to update saved opportunity.', true);
    } finally {
      pendingSavedJobIds.delete(id);
      $$(`[data-save-job-id="${id}"]`).forEach(button => { button.disabled = false; button.removeAttribute('aria-busy'); });
    }
  }

  async function renderSavedOpportunities() {
    try {
      const data = await api('/candidate/saved-jobs');
      savedJobsCache = data.saved_jobs || [];
      savedJobIds = new Set(savedJobsCache.map(job => Number(job.id)));
      const content = $('#main-content');
      content.innerHTML = `
        <div class="page-heading"><div><h1>Saved Opportunities</h1><p>Revisit openings you bookmarked. Expired and unavailable opportunities remain here for reference and can be removed.</p></div><button class="btn btn-outline" onclick="window.jobMatcher.loadView('jobs')"><i data-lucide="search"></i> Browse jobs</button></div>
        ${savedJobsCache.length ? `<div class="job-grid">${savedJobsCache.map(job => `
          <article class="job-card saved-job-card" data-saved-card-id="${job.id}">
            <div class="job-card-head"><div class="company-badge">${esc((job.company_name || 'C').substring(0,2).toUpperCase())}</div><div class="job-card-title" style="flex:1"><h3>${esc(job.title)}</h3><p>${esc(job.company_name)} · ${esc(job.industry || 'Company')}</p></div><span class="status-pill ${job.is_available ? 'published' : esc(job.lifecycle_status)}">${job.is_available ? 'Active' : esc(job.lifecycle_status)}</span></div>
            ${renderSourceBadge(job)}
            <small class="muted">${esc(opportunityBranchLabel(job))}</small>
            <small class="muted saved-job-category">${esc((job.opportunity_category || 'job').replaceAll('_', ' '))} · ${esc(job.opportunity_type||job.job_type||'Opportunity type not specified')}</small>
            <div class="job-meta-row"><span><i data-lucide="map-pin"></i> ${esc(job.location || 'Location not specified')}</span><span><i data-lucide="home"></i> ${esc(job.work_mode || 'Work mode not specified')}</span><span><i data-lucide="briefcase"></i> ${esc(job.opportunity_type||job.job_type||'Opportunity')}</span><span><i data-lucide="calendar"></i> ${esc(opportunityDeadlineLabel(job))}</span></div>
            <p class="saved-job-description">${esc(job.description || 'No description provided.')}</p>
            <div class="skill-chips">${(job.required_skills || []).slice(0,6).map(skill => `<span class="skill-chip">${esc(skill.name)}${skill.is_required ? '' : ' · Optional'}</span>`).join('') || '<span class="muted">No specific skills listed.</span>'}</div>
            ${renderSkillGapHTML(job)}
            ${job.is_expired ? '<p class="saved-expired-note"><i data-lucide="clock-3"></i> This opportunity has expired. Applications are unavailable.</p>' : (!job.is_available ? '<p class="saved-expired-note">This opportunity is currently unavailable.</p>' : '')}
            <div class="saved-job-actions"><button class="btn btn-outline" onclick="window.jobMatcher.openSavedJobDetails(${job.id})"><i data-lucide="eye"></i> Details</button>${job.is_available ? renderApplicationAction(job, 'Apply') : ''}${renderSaveButton(job.id)}</div>
          </article>`).join('')}</div>` : `<div class="panel saved-empty-state"><i data-lucide="bookmark" aria-hidden="true"></i><h3>No saved opportunities yet</h3><p class="muted">Browse active openings and save the ones you want to revisit.</p><button class="btn btn-primary" onclick="window.jobMatcher.loadView('jobs')">Explore opportunities</button></div>`}
      `;
      refreshIcons();
    } catch (error) {
      $('#main-content').innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54">Failed to load saved opportunities: ${esc(error.message)}</p><button class="btn btn-outline" onclick="window.jobMatcher.loadView('saved-jobs')">Try again</button></div>`;
    }
  }

  function openSavedJobDetails(jobId) {
    const job = savedJobsCache.find(item => Number(item.id) === Number(jobId));
    if (!job) { toast('Saved opportunity details are not available. Refresh the saved list.', true); return; }
    const canApply = Boolean(job.is_available);
    $('#modal-root').innerHTML = `
      <div class="modal-backdrop"><div class="modal">
        <div class="modal-head"><div><h3>${esc(job.title)}</h3><p class="muted">${esc(job.company_name)} · ${esc(job.work_mode||'Work mode not specified')} · ${esc(job.location)}</p></div><button class="icon-btn" onclick="window.jobMatcher.closeModal()"><i data-lucide="x"></i></button></div>
        <div class="modal-body" style="display:grid;gap:14px;">
          <p class="muted">${renderSourceBadge(job)} ${job.source_url?`· <a href="${esc(job.source_url)}" target="_blank" rel="noopener noreferrer">Official source</a>`:''}</p>
          <div><span class="status-pill ${canApply ? 'published' : esc(job.lifecycle_status)}">${canApply ? 'Active' : esc(job.lifecycle_status)}</span>${job.is_expired ? '<span class="muted" style="margin-left:8px">Applications are closed</span>' : ''}</div>
          <div class="job-meta-row"><span>${esc(opportunityDeadlineLabel(job))}</span>${opportunityCompensationLabel(job)?`<span>${esc(opportunityCompensationLabel(job))}</span>`:''}<span>${esc(job.opportunity_type||job.job_type||'Opportunity')}</span></div>
          <p class="muted">${renderSourceBadge(job)} · ${esc(job.opportunity_category||'')} · ${esc(opportunityBranchLabel(job))}</p>
          <div><b>Description</b><p class="muted">${esc(job.description || 'No description provided.')}</p></div><div><b>Requirements</b><p class="muted">${esc(job.requirements || 'No additional requirements provided.')}</p></div>
          <div><b>Skills</b><div class="skill-chips">${(job.required_skills || []).map(skill => `<span class="skill-chip">${esc(skill.name)} · ${esc(skill.min_proficiency || 'Intermediate')}${skill.is_required ? ' · Required' : ' · Optional'}</span>`).join('') || '<span class="muted">No specific skills listed.</span>'}</div></div>
          ${renderSkillGapHTML(job)}
          <div class="saved-job-actions">${renderSaveButton(job.id)}${canApply ? renderApplicationAction(job, 'Apply') : ''}</div>
        </div>
      </div></div>`;
    refreshIcons();
  }

  async function renderCandidateApplications(filters = {}) {
    try {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
      const data = await api(`/candidate/applications${query.toString() ? `?${query}` : ''}`);
      const apps = data.applications || [];
      const counts = data.status_counts || {};
      const total = Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);
      const filterStatuses = ["submitted", "under_review", "shortlisted", "interview", "selected", "rejected", "withdrawn"];
      const withdrawable = new Set(["submitted", "under_review", "shortlisted"]);

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>Application Tracker</h1>
            <p>Follow each application from submission through its latest recruiter update.</p>
          </div>
        </div>

        <div class="metrics-grid application-metrics">
          <div class="metric-card"><div class="metric-icon blue"><i data-lucide="files"></i></div><div><span class="metric-label">TOTAL APPLICATIONS</span><div class="metric-value">${total}</div><span class="metric-foot">Across all opportunities</span></div></div>
          <div class="metric-card"><div class="metric-icon gold"><i data-lucide="eye"></i></div><div><span class="metric-label">UNDER REVIEW</span><div class="metric-value">${Number(counts.under_review || 0)}</div><span class="metric-foot">Being evaluated</span></div></div>
          <div class="metric-card"><div class="metric-icon green"><i data-lucide="star"></i></div><div><span class="metric-label">SHORTLISTED</span><div class="metric-value">${Number(counts.shortlisted || 0)}</div><span class="metric-foot">Advanced to next stage</span></div></div>
          <div class="metric-card"><div class="metric-icon purple"><i data-lucide="messages-square"></i></div><div><span class="metric-label">INTERVIEWS</span><div class="metric-value">${Number(counts.interview || 0)}</div><span class="metric-foot">Interview stage</span></div></div>
          <div class="metric-card"><div class="metric-icon green"><i data-lucide="badge-check"></i></div><div><span class="metric-label">SELECTED</span><div class="metric-value">${Number(counts.selected || 0)}</div><span class="metric-foot">Successful outcomes</span></div></div>
          <div class="metric-card"><div class="metric-icon purple"><i data-lucide="circle-x"></i></div><div><span class="metric-label">REJECTED</span><div class="metric-value">${Number(counts.rejected || 0)}</div><span class="metric-foot">Closed applications</span></div></div>
        </div>

        <form id="candidate-application-filters" class="panel application-filter-bar" style="margin-bottom:16px;display:flex;align-items:end;gap:12px;flex-wrap:wrap;">
          <div class="form-field" style="min-width:210px;flex:1;"><label for="candidate-application-status">Filter by status</label><select class="form-select" id="candidate-application-status" name="status"><option value="">All applications (${total})</option>${filterStatuses.map(status => `<option value="${status}" ${filters.status === status ? 'selected' : ''}>${applicationStatusLabel(status)} (${Number(counts[status] || 0)})</option>`).join('')}</select></div>
          <button class="btn btn-primary" type="submit"><i data-lucide="list-filter"></i> Apply filter</button>
          ${filters.status ? '<button class="btn btn-outline" type="button" id="clear-application-filter">Clear</button>' : ''}
        </form>

        ${apps.length === 0 ? `
          <div class="panel application-empty-state" style="text-align:center;padding:42px 20px;">
            <i data-lucide="clipboard-list" style="width:36px;height:36px;color:#829487;margin-bottom:10px;"></i>
            <h3>${filters.status ? `No ${applicationStatusLabel(filters.status).toLowerCase()} applications` : 'No applications yet'}</h3>
            <p class="muted">${filters.status ? 'Choose another status or clear the filter.' : 'Browse opportunities that fit your skills and submit your first application.'}</p>
            ${filters.status ? '<button class="btn btn-outline" type="button" id="empty-clear-application-filter">Show all applications</button>' : '<button class="btn btn-primary" onclick="window.jobMatcher.loadView(\'jobs\')">Browse Opportunities</button>'}
          </div>
        ` : `
          <div class="application-list" style="display:grid;gap:14px;">
            ${apps.map(a => `
              <article class="panel application-card">
                <div class="application-card-heading" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:13px;">
                  <div>
                    <h3 style="font-size:15px;margin:0 0 5px;">${esc(a.job_title)}</h3>
                    <p class="muted" style="font-size:11px;margin:0;">
                      <b>${esc(a.company_name || 'Organization not listed')}</b> · ${esc(a.job_type || a.opportunity_type || 'Opportunity')} · ${esc(a.work_mode || 'Work mode not specified')} · Applied ${formatDate(a.applied_at)}${a.opportunity_status === 'expired' ? ' · Opportunity expired; application history retained' : ''}
                    </p>
                  </div>
                  <span class="status-pill ${esc(a.current_status)}">${applicationStatusLabel(a.current_status)}</span>
                </div>

                ${a.cover_letter ? `
                  <div class="application-cover-note" style="background:#f5f6f1;border:1px solid #e8ebe4;border-radius:8px;padding:10px 12px;font-size:11px;margin-bottom:14px;">
                    <b>Your note:</b> ${esc(a.cover_letter)}
                  </div>
                ` : ''}

                <div class="application-timeline" aria-label="Application status timeline">
                  <h4>Status timeline</h4>
                  ${(a.status_history || []).length ? `<ol>${a.status_history.map(h => `
                    <li><span class="application-timeline-dot"></span><div><b>${h.previous_status ? `${applicationStatusLabel(h.previous_status)} → ` : ''}${applicationStatusLabel(h.status)}</b><small>${formatDate(h.changed_at)}${h.changed_by ? ` · ${esc(h.changed_by)}` : ''}</small>${h.notes ? `<p>${esc(h.notes)}</p>` : ''}</div></li>
                  `).join('')}</ol>` : '<p class="muted">Status history is not available for this application.</p>'}
                </div>
                <details class="application-opportunity-details"><summary>Opportunity details</summary><div><p><b>Deadline:</b> ${formatDate(a.job_deadline)} · <b>Location:</b> ${esc(a.job_location || 'Not specified')}</p><p>${esc(a.job_description || 'No opportunity description was provided.')}</p>${a.job_requirements ? `<p><b>Requirements:</b> ${esc(a.job_requirements)}</p>` : ''}</div></details>
                <div class="application-card-actions">
                  <span class="muted">Application #${Number(a.application_id)}</span>
                  ${withdrawable.has(a.current_status) ? `<button class="btn btn-outline btn-sm" type="button" onclick="window.jobMatcher.withdrawApplication(${Number(a.application_id)})">Withdraw application</button>` : ''}
                </div>
              </article>
            `).join("")}
          </div>
        `}
      `;
      $('#candidate-application-filters').addEventListener('submit', event => {
        event.preventDefault();
        const status = new FormData(event.currentTarget).get('status');
        renderCandidateApplications(status ? { status } : {});
      });
      $('#clear-application-filter')?.addEventListener('click', () => renderCandidateApplications());
      $('#empty-clear-application-filter')?.addEventListener('click', () => renderCandidateApplications());
      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load applications: ${esc(e.message)}</p></div>`;
    }
  }

  async function renderCandidateProfile() {
    try {
      const data = await api("/candidate/profile");
      const p = data.profile || {};
      const skills = data.skills || [];
      const edu = data.education || [];
      const exp = data.experience || [];
      const ach = data.achievements || [];
      const resumes = data.resumes || [];
      const pref = data.preferences || {};
      const { percentage: completion, missing: missingSections } = candidateProfileCompletion(data);

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>Candidate Profile & Technical Portfolio</h1>
            <p>Maintain your contact info, technical skills, academic history, CV uploads, and job preferences.</p>
          </div>
        </div>

        <section class="panel" style="margin-bottom:20px" aria-labelledby="resume-autofill-heading">
          <div class="panel-head"><div><h3 id="resume-autofill-heading">Resume profile autofill</h3><p class="muted">Upload a text-based PDF to extract suggestions locally. The extraction file is processed for this request only and is not saved.</p></div></div>
          <form id="resume-parse-form" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <input type="file" id="resume-parse-file" name="resume" accept="application/pdf,.pdf" class="form-input" required style="flex:1;min-width:220px">
            <button type="submit" class="btn btn-mint"><i data-lucide="scan-text"></i> Extract Profile Information</button>
          </form>
          <p id="resume-parse-status" class="muted" aria-live="polite"></p>
          <div id="resume-extraction-review" hidden></div>
        </section>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;">
          <!-- 1. Bio & Contact Details Form -->
          <div class="panel">
            <div class="panel-head">
              <h3>Biographical & Contact Info</h3>
            </div>
            <form id="profile-bio-form" class="form-grid">
              <div class="form-field full">
                <label>Full Name</label>
                <input class="form-input" name="full_name" value="${esc(p.full_name || '')}" required />
              </div>
              <div class="form-field">
                <label>Email Address</label>
                <input class="form-input" name="email" type="email" value="${esc(p.email || '')}" />
              </div>
              <div class="form-field">
                <label>Phone Number</label>
                <input class="form-input" name="phone" value="${esc(p.phone || '')}" />
              </div>
              <div class="form-field full">
                <label>Location (City, Country)</label>
                <input class="form-input" name="location" value="${esc(p.location || '')}" />
              </div>
              <div class="form-field full">
                <label>Professional Headline</label>
                <input class="form-input" name="headline" value="${esc(p.headline || '')}" placeholder="e.g. Python & PostgreSQL Backend Developer" />
              </div>
              <div class="form-field full">
                <label>Bio / Summary</label>
                <textarea class="form-textarea" name="bio">${esc(p.bio || '')}</textarea>
              </div>
              <div class="form-field">
                <label>GitHub URL</label>
                <input class="form-input" name="github_url" value="${esc(p.github_url || '')}" />
              </div>
              <div class="form-field">
                <label>LinkedIn URL</label>
                <input class="form-input" name="linkedin_url" value="${esc(p.linkedin_url || '')}" />
              </div>
              <div class="form-field full" style="margin-top:10px;">
                <button type="submit" class="btn btn-primary"><i data-lucide="save"></i> Save Profile Details</button>
              </div>
            </form>
          </div>

          <!-- 2. Job Preferences Form -->
          <div class="panel">
            <div class="panel-head">
              <h3>Job Preferences (Matchmaking Input)</h3>
            </div>
            <form id="profile-pref-form" class="form-grid">
              <div class="form-field full">
                <label>Desired Target Role</label>
                <input class="form-input" name="preferred_role" value="${esc(pref.preferred_role || '')}" placeholder="e.g. Backend Software Engineer" />
              </div>
              <div class="form-field full"><label>Opportunity Categories</label><div class="skill-chips">${[['job','Jobs'],['internship','Internships'],['hackathon','Hackathons'],['project','Projects'],['open_source','Open source'],['research','Research'],['scholarship','Scholarships'],['fellowship','Fellowships'],['competition','Competitions'],['workshop','Workshops'],['developer_program','Developer programs'],['startup','Startups'],['apprenticeship','Apprenticeships'],['certification','Certifications'],['government','Government'],['psu','PSU'],['gate','GATE'],['training','Training']].map(([value,label])=>`<label class="skill-chip"><input type="checkbox" name="preferred_categories" value="${value}" ${(pref.preferred_categories||[]).includes(value)?'checked':''}> ${label}</label>`).join('')}</div></div>
              <div class="form-field">
                <label>Preferred Location</label>
                <input class="form-input" name="preferred_location" value="${esc(pref.preferred_location || '')}" placeholder="e.g. Bengaluru, Remote" />
              </div>
              <div class="form-field">
                <label>Preferred Work Mode</label>
                <select class="form-select" name="preferred_work_mode">
                  <option value="Any" ${pref.preferred_work_mode === 'Any' ? 'selected' : ''}>Any</option>
                  <option value="Remote" ${pref.preferred_work_mode === 'Remote' ? 'selected' : ''}>Remote</option>
                  <option value="Hybrid" ${pref.preferred_work_mode === 'Hybrid' ? 'selected' : ''}>Hybrid</option>
                  <option value="On-site" ${pref.preferred_work_mode === 'On-site' ? 'selected' : ''}>On-site</option>
                </select>
              </div>
              <div class="form-field full">
                <label>Minimum Expected Annual Salary (₹ INR)</label>
                <input class="form-input" type="number" step="10000" name="min_expected_salary" value="${pref.min_expected_salary || 0}" />
              </div>
              <div class="form-field full" style="margin-top:10px;">
                <button type="submit" class="btn btn-primary"><i data-lucide="save"></i> Save Job Preferences</button>
              </div>
            </form>

            <!-- Resume / CV Upload Section -->
            <div style="margin-top:24px;border-top:1px solid #edf0f5;padding-top:18px;">
              <div class="panel-head">
                <h3>Resumes attached to applications</h3>
              </div>
              <p class="muted" style="font-size:11px">This separate upload stores your selected CV in your private account so you can attach it to applications. Use the PDF extraction panel above for temporary profile autofill.</p>
              <form id="resume-upload-form" style="display:flex;gap:8px;margin-bottom:14px;">
                <input type="file" id="resume-file-input" name="resume" accept=".pdf,.doc,.docx,.txt" class="form-input" style="flex:1;" required />
                <button type="submit" class="btn btn-mint"><i data-lucide="upload"></i> Upload CV</button>
              </form>

              <div style="display:grid;gap:8px;">
                ${resumes.length === 0 ? `<p class="muted" style="font-size:11px;">No resumes uploaded yet. Upload a PDF/DOC CV above.</p>` : resumes.map(r => `
                  <div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;background:#f8fafd;border:1px solid #e5edf7;border-radius:9px;font-size:11px;">
                    <div style="display:flex;align-items:center;gap:8px;">
                      <i data-lucide="file-text" style="width:16px;color:#4169e1;"></i>
                      <span><b>${esc(r.file_name)}</b> ${r.is_default ? '<span style="color:#159b73;font-weight:700;">(Default)</span>' : ''}</span>
                    </div>
                    <div style="display:flex;gap:6px;">
                      <a href="/${esc(r.file_path)}" target="_blank" class="btn btn-outline btn-sm"><i data-lucide="eye"></i> View</a>
                      ${!r.is_default ? `<button class="btn btn-soft btn-sm" onclick="window.jobMatcher.setDefaultResume(${r.id})">Set Default</button>` : ''}
                      <button class="btn btn-danger btn-sm" onclick="window.jobMatcher.deleteResume(${r.id})"><i data-lucide="trash"></i></button>
                    </div>
                  </div>
                `).join("")}
              </div>
            </div>
          </div>
        </div>

        <div class="panel" style="margin-bottom:20px"><div style="display:flex;justify-content:space-between;gap:12px"><div><h3>Profile completeness · ${completion}%</h3><p class="muted">${missingSections.length ? `Next, complete: ${missingSections.map(esc).join(', ')}` : 'Your profile has all key sections.'}</p></div><b>${completion}%</b></div><progress value="${completion}" max="100" style="width:100%"></progress></div>

        <!-- 3. Skills Section -->
        <div class="panel" style="margin-bottom:20px;">
          <div class="panel-head">
            <div>
              <h3>Technical Skills & Proficiencies</h3>
              <p>Skills directly feed the transparent SQL matching engine</p>
            </div>
          </div>

          <form id="add-skill-form" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">
            <input id="skill-name-input" class="form-input" style="flex:1;min-width:180px;" placeholder="Skill name (e.g. Python, React, PostgreSQL)..." required />
            <select id="skill-prof-select" class="form-select" style="min-width:140px;">
              <option value="Beginner">Beginner</option>
              <option value="Intermediate" selected>Intermediate</option>
              <option value="Advanced">Advanced</option>
              <option value="Expert">Expert</option>
            </select>
            <input id="skill-exp-input" type="number" step="0.5" min="0" value="1.0" class="form-input" style="width:110px;" placeholder="Years Exp" />
            <button type="submit" class="btn btn-primary"><i data-lucide="plus"></i> Add Skill</button>
          </form>

          <div class="skill-chips">
            ${skills.length === 0 ? `<p class="muted">No skills added yet.</p>` : skills.map(s => `
              <span class="skill-chip match" style="display:inline-flex;align-items:center;gap:8px;padding:6px 12px;font-size:11px;">
                <b>${esc(s.skill_name)}</b>
                <small style="color:#117252;">${esc(s.proficiency)} · ${s.years_of_experience} yrs</small>
                <button type="button" class="btn btn-soft btn-sm" onclick="window.jobMatcher.editSkill(${s.skill_id})">Edit</button>
                <button type="button" onclick="window.jobMatcher.deleteSkill(${s.id})" style="border:0;background:none;color:#9aa7bb;cursor:pointer;padding:0 2px;"><i data-lucide="x" style="width:12px;"></i></button>
              </span>
            `).join("")}
          </div>
        </div>

        <!-- 4. Academic Education & Experience Lists -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
          <div class="panel">
            <div class="panel-head">
              <h3>Academic Education</h3>
              <button class="btn btn-soft btn-sm" onclick="window.jobMatcher.openAddEducationModal()"><i data-lucide="plus"></i> Add Degree</button>
            </div>
            <div style="display:grid;gap:10px;">
              ${edu.length === 0 ? `<p class="muted">No education records added.</p>` : edu.map(e => `
                <div style="padding:10px 12px;border:1px solid #edf0f5;border-radius:10px;display:flex;justify-content:space-between;align-items:center;">
                  <div>
                    <b style="font-size:12px;display:block;">${esc(e.degree)} in ${esc(e.field_of_study || 'Engineering')}</b>
                    <span style="font-size:11px;color:#78869c;">${esc(e.institution)} · ${e.start_year || ''} - ${e.end_year || 'Present'} (${esc(e.grade || '')})</span>
                  </div>
                  <div><button class="btn btn-soft btn-sm" onclick="window.jobMatcher.editEducation(${e.id})">Edit</button><button class="btn btn-danger btn-sm" onclick="window.jobMatcher.deleteEducation(${e.id})"><i data-lucide="trash"></i></button></div>
                </div>
              `).join("")}
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <h3>Work & Internship Experience</h3>
              <button class="btn btn-soft btn-sm" onclick="window.jobMatcher.openAddExperienceModal()"><i data-lucide="plus"></i> Add Experience</button>
            </div>
            <div style="display:grid;gap:10px;">
              ${exp.length === 0 ? `<p class="muted">No experience entries added (optional).</p>` : exp.map(x => `
                <div style="padding:10px 12px;border:1px solid #edf0f5;border-radius:10px;display:flex;justify-content:space-between;align-items:center;">
                  <div>
                    <b style="font-size:12px;display:block;">${esc(x.role_title)} at ${esc(x.company_name)}</b>
                    <span style="font-size:11px;color:#78869c;">${formatDate(x.start_date)} to ${x.is_current ? 'Present' : formatDate(x.end_date)}</span>
                  </div>
                  <div><button class="btn btn-soft btn-sm" onclick="window.jobMatcher.editExperience(${x.id})">Edit</button><button class="btn btn-danger btn-sm" onclick="window.jobMatcher.deleteExperience(${x.id})"><i data-lucide="trash"></i></button></div>
                </div>
              `).join("")}
            </div>
          </div>
        </div>
        <div class="panel" style="margin-top:20px"><div class="panel-head"><h3>Achievements</h3></div>
          <form id="achievement-form" class="form-grid"><div class="form-field"><label>Title</label><input class="form-input" name="title" required></div><div class="form-field"><label>Issuer</label><input class="form-input" name="issuer"></div><div class="form-field"><label>Date</label><input class="form-input" type="date" name="issue_date"></div><div class="form-field"><label>Description</label><input class="form-input" name="description"></div><button class="btn btn-primary">Add achievement</button></form>
          <div style="display:grid;gap:8px;margin-top:12px">${ach.length?ach.map(a=>`<div class="skill-chip" style="display:flex;justify-content:space-between"><span><b>${esc(a.title)}</b> · ${esc(a.issuer||'')} · ${formatDate(a.issue_date)}<br>${esc(a.description||'')}</span><div><button class="btn btn-soft btn-sm" onclick="window.jobMatcher.editAchievement(${a.id})">Edit</button><button class="btn btn-danger btn-sm" onclick="window.jobMatcher.deleteAchievement(${a.id})">Delete</button></div></div>`).join(''):'<p class="muted">No achievements yet. Add awards, certifications, or projects.</p>'}</div>
        </div>
      `;

      // Attach handlers
      $("#profile-bio-form").addEventListener("submit", async e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = Object.fromEntries(fd.entries());
        try {
          await api("/candidate/profile", { method: "PUT", body: JSON.stringify(body) });
          toast("Profile biographical info saved!");
          renderCandidateProfile();
        } catch (err) {
          toast(err.message, true);
        }
      });

      $("#resume-parse-form").addEventListener("submit", async e => {
        e.preventDefault();
        const input = $("#resume-parse-file");
        const button = e.submitter || e.currentTarget.querySelector('button[type="submit"]');
        if (!input.files?.length) return;
        if (input.files[0].size > 5 * 1024 * 1024) {
          $("#resume-parse-status").textContent = "PDF resumes must be 5 MB or smaller.";
          return;
        }
        const formData = new FormData();
        formData.append("resume", input.files[0]);
        button.disabled = true;
        button.textContent = "Extracting…";
        $("#resume-parse-status").textContent = "Processing the PDF locally on the SkillBridge server…";
        try {
          const result = await api("/candidate/resumes/parse", { method: "POST", body: formData });
          $("#resume-extraction-review").innerHTML = renderResumeReviewForm(result.extracted || {}, p, skills, edu);
          $("#resume-extraction-review").hidden = false;
          $("#resume-parse-status").textContent = "Review the extracted suggestions and manually complete any missing details.";
          $("#resume-review-form").addEventListener("submit", async reviewEvent => {
            reviewEvent.preventDefault();
            const reviewForm = reviewEvent.currentTarget;
            const saveButton = reviewEvent.submitter || reviewForm.querySelector('button[type="submit"]');
            const fd = new FormData(reviewForm);
            const profilePayload = Object.fromEntries(["full_name", "email", "phone", "location", "headline"].map(key => [key, fd.get(key) || ""]));
            const skillsByKey = new Map();
            String(fd.get("skills") || "").split(/[\n,;]+/).map(value => value.trim()).filter(Boolean).forEach(name => {
              const key = normalizeSkillForProfile(name);
              if (key && !skillsByKey.has(key)) skillsByKey.set(key, name);
            });
            const skillNames = [...skillsByKey.values()];
            const educationDraft = {
              institution: String(fd.get("education_institution") || "").trim(),
              degree: String(fd.get("education_degree") || "").trim(),
              field_of_study: String(fd.get("education_field") || "").trim(),
              start_year: fd.get("education_start_year") ? Number(fd.get("education_start_year")) : null,
              end_year: fd.get("education_end_year") ? Number(fd.get("education_end_year")) : null,
              grade: String(fd.get("education_grade") || "").trim(),
            };
            const hasEducation = Object.values(educationDraft).some(value => value !== null && value !== "");
            const educationNeedsCompletion = hasEducation && (!educationDraft.institution || !educationDraft.degree);
            if (educationDraft.start_year && educationDraft.end_year && educationDraft.end_year < educationDraft.start_year) {
              toast("Education end year must be on or after the start year.", true);
              return;
            }
            if ([educationDraft.start_year, educationDraft.end_year].some(year => year !== null && (!Number.isInteger(year) || year < 1950 || year > 2100))) {
              toast("Education years must be between 1950 and 2100.", true);
              return;
            }
            saveButton.disabled = true;
            saveButton.textContent = "Saving profile…";
            try {
              await api("/candidate/profile", { method: "PUT", body: JSON.stringify(profilePayload) });
              const prefForm = $("#profile-pref-form");
              const prefData = new FormData(prefForm);
              const prefPayload = Object.fromEntries(prefData.entries());
              prefPayload.preferred_categories = prefData.getAll("preferred_categories");
              prefPayload.min_expected_salary = Number(prefPayload.min_expected_salary || 0);
              await api("/candidate/preferences", { method: "PUT", body: JSON.stringify(prefPayload) });
              const existingKeys = new Set(skills.map(item => normalizeSkillForProfile(item.skill_name)));
              for (const name of skillNames) {
                const key = normalizeSkillForProfile(name);
                if (!key || existingKeys.has(key)) continue;
                await api("/candidate/skills", { method: "POST", body: JSON.stringify({ skill_name: name, proficiency: "Beginner", years_of_experience: 0 }) });
                existingKeys.add(key);
              }
              const selectedKeys = new Set(skillNames.map(normalizeSkillForProfile).filter(Boolean));
              for (const savedSkill of skills) {
                if (!selectedKeys.has(normalizeSkillForProfile(savedSkill.skill_name))) {
                  await api(`/candidate/skills/${savedSkill.id}`, { method: "DELETE" });
                }
              }
              if (hasEducation && !educationNeedsCompletion) {
                const currentDuplicate = edu.some(item => item.institution?.toLowerCase() === educationDraft.institution.toLowerCase() && item.degree?.toLowerCase() === educationDraft.degree.toLowerCase() && Number(item.end_year || 0) === Number(educationDraft.end_year || 0));
                if (!currentDuplicate) await api("/candidate/education", { method: "POST", body: JSON.stringify(educationDraft) });
              }
              toast(educationNeedsCompletion ? "Profile, preferences, and skills saved. Complete the education institution and degree to save that suggestion." : "Profile, preferences, and reviewed resume suggestions saved.");
              renderCandidateProfile();
            } catch (saveError) {
              toast(saveError.message || "Unable to save reviewed profile suggestions.", true);
              saveButton.disabled = false;
              saveButton.innerHTML = '<i data-lucide="save"></i> Save Profile & Preferences';
              refreshIcons();
            }
          });
          refreshIcons();
        } catch (parseError) {
          $("#resume-parse-status").textContent = parseError.message || "Unable to extract profile details.";
          $("#resume-extraction-review").hidden = true;
        } finally {
          button.disabled = false;
          button.innerHTML = '<i data-lucide="scan-text"></i> Extract Profile Information';
          refreshIcons();
        }
      });

      $("#profile-pref-form").addEventListener("submit", async e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const body = Object.fromEntries(fd.entries());
        body.preferred_categories = fd.getAll('preferred_categories');
        const submit=e.submitter; if(submit){submit.disabled=true;submit.textContent='Saving…'}
        try {
          await api("/candidate/preferences", { method: "PUT", body: JSON.stringify(body) });
          toast("Job preferences updated!");
          renderCandidateProfile();
        } catch (err) {
          toast(err.message, true);
        } finally { if(submit){submit.disabled=false;submit.textContent='Save Job Preferences'} }
      });
      $('#achievement-form').addEventListener('submit', async e=>{e.preventDefault();const form=e.currentTarget,btn=form.querySelector('button[type="submit"]');const body=Object.fromEntries(new FormData(form).entries());btn.disabled=true;try{await api('/candidate/achievements',{method:'POST',body:JSON.stringify(body)});toast('Achievement added.');renderCandidateProfile()}catch(err){toast(err.message,true);btn.disabled=false}});

      $("#resume-upload-form").addEventListener("submit", async e => {
        e.preventDefault();
        const fileInput = $("#resume-file-input");
        if (!fileInput.files.length) return;
        const fd = new FormData();
        fd.append("resume", fileInput.files[0]);
        const submit = e.submitter;
        if (submit) { submit.disabled = true; submit.textContent = "Uploading…"; }

        try {
          await api("/candidate/resumes/upload", { method: "POST", body: fd });
          toast("CV uploaded successfully!");
          renderCandidateProfile();
        } catch (err) {
          toast(err.message, true);
          if (submit) { submit.disabled = false; submit.innerHTML = '<i data-lucide="upload"></i> Upload CV'; refreshIcons(); }
        }
      });

      $("#add-skill-form").addEventListener("submit", async e => {
        e.preventDefault();
        const skillName = $("#skill-name-input").value;
        const prof = $("#skill-prof-select").value;
        const expYears = $("#skill-exp-input").value;
        const submit = e.submitter;
        if (submit) { submit.disabled = true; submit.textContent = "Saving…"; }

        try {
          await api("/candidate/skills", {
            method: "POST",
            body: JSON.stringify({
              skill_name: skillName,
              proficiency: prof,
              years_of_experience: expYears
            })
          });
          toast(`Skill '${skillName}' added!`);
          renderCandidateProfile();
        } catch (err) {
          toast(err.message, true);
          if (submit) { submit.disabled = false; submit.innerHTML = '<i data-lucide="plus"></i> Add Skill'; refreshIcons(); }
        }
      });

      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load profile: ${esc(e.message)}</p></div>`;
    }
  }

  // --------------------------------------------------------------------------
  // ANALYTICS VIEWS — values are rendered from role-scoped database aggregates.
  // --------------------------------------------------------------------------
  function analyticsBars(title, description, rows, labelKey, valueKey) {
    const items = rows || [];
    const maxValue = Math.max(1, ...items.map(item => Number(item[valueKey]) || 0));
    return `<section class="panel analytics-panel">
      <div class="panel-head"><div><h3>${esc(title)}</h3><p>${esc(description)}</p></div></div>
      ${items.length && items.some(item => Number(item[valueKey]) > 0) ? `<div class="analytics-bars">${items.map(item => {
        const value = Math.max(0, Number(item[valueKey]) || 0);
        return `<div class="analytics-bar-row"><span class="analytics-bar-label">${esc(item[labelKey] || "Other")}</span><div class="analytics-track" role="img" aria-label="${esc(item[labelKey] || "Other")}: ${value}"><span style="width:${Math.min(100, value * 100 / maxValue)}%"></span></div><b>${value.toLocaleString("en-IN")}</b></div>`;
      }).join("")}</div>` : `<p class="analytics-empty">There is no recorded activity for this chart yet.</p>`}
    </section>`;
  }

  function analyticsMetric(label, value, detail, icon) {
    const displayValue = typeof value === "string" ? value : (Number(value) || 0).toLocaleString("en-IN");
    return `<article class="metric-card analytics-metric"><div class="metric-icon blue"><i data-lucide="${esc(icon)}"></i></div><div><span class="metric-label">${esc(label)}</span><div class="metric-value">${esc(displayValue)}</div><span class="metric-foot">${esc(detail)}</span></div></article>`;
  }

  async function renderAnalytics() {
    const role = currentUser?.role;
    const endpoint = role === "user" ? "/analytics/candidate" : role === "recruiter" ? "/analytics/recruiter" : "/analytics/admin";
    const retry = `<button class="btn btn-outline" onclick="window.jobMatcher.loadView('analytics')">Try again</button>`;
    try {
      const data = await api(endpoint);
      const summary = data.summary || {};
      const main = $("#main-content");
      if (role === "user") {
        const completion = data.profile_completeness || { percentage: 0, missing_sections: [] };
        const statusRows = (data.application_statuses || []).filter(row => Number(row.count) > 0).map(row => ({ ...row, status: applicationStatusLabel(row.status) }));
        const skills = data.skills || [];
        const gaps = data.skill_gaps || [];
        main.innerHTML = `
          <div class="page-heading analytics-heading"><div><span class="eyebrow">YOUR CAREER SNAPSHOT</span><h1>Analytics & Insights</h1><p>See your application progress and the skills appearing most often across eligible active opportunities.</p></div><button class="btn btn-outline" onclick="window.jobMatcher.loadView('profile')"><i data-lucide="user-round-pen"></i> Improve profile</button></div>
          <div class="metrics-grid analytics-kpis">
            ${analyticsMetric("APPLICATIONS", summary.total_applications, "Submitted to recruiters", "clipboard-check")}
            ${analyticsMetric("SAVED OPPORTUNITIES", summary.saved_opportunities, "Kept for later", "bookmark")}
            ${analyticsMetric("OPPORTUNITIES APPLIED TO", summary.opportunities_applied_to, "Distinct listings", "briefcase-business")}
            ${analyticsMetric("PROFILE COMPLETENESS", `${completion.percentage}%`, completion.missing_sections.length ? `${completion.missing_sections.length} sections to complete` : "Key sections complete", "circle-user-round")}
          </div>
          <div class="analytics-grid">
            ${analyticsBars("Application progress", "Current status of your submitted applications", statusRows, "status", "count")}
            ${analyticsBars("Application funnel", "Progress recorded by the application workflow", data.application_funnel || [], "stage", "count")}
            ${analyticsBars("Applications over time", "Monthly applications using recorded submission dates", data.application_activity || [], "month", "count")}
            <section class="panel analytics-panel"><div class="panel-head"><div><h3>Your skills</h3><p>Skills saved in your candidate profile</p></div><span class="analytics-count">${skills.length}</span></div>${skills.length ? `<div class="analytics-chip-list">${skills.map(skill => `<span class="analytics-chip">${esc(skill.name)}${skill.proficiency ? ` · ${esc(skill.proficiency)}` : ""}</span>`).join("")}</div>` : `<p class="analytics-empty">Add skills to your profile to personalize matching and identify relevant gaps.</p><button class="btn btn-soft btn-sm" onclick="window.jobMatcher.loadView('profile')">Add profile skills</button>`}</section>
            <section class="panel analytics-panel analytics-gaps"><div class="panel-head"><div><h3>Skills to strengthen</h3><p>Required by active opportunities matching your branch eligibility${data.candidate_branch ? ` · ${esc(data.candidate_branch)}` : ""}</p></div><span class="analytics-count">${Number(data.matching_opportunities) || 0} eligible openings</span></div>${gaps.length ? `<div class="analytics-gap-list">${gaps.map((gap, index) => `<div class="analytics-gap-row"><span class="analytics-gap-rank">${index + 1}</span><b>${esc(gap.name)}</b><span>Required by ${Number(gap.opportunity_count) || 0} ${Number(gap.opportunity_count) === 1 ? "opening" : "openings"}</span></div>`).join("")}</div><p class="analytics-note">Start with skills listed across several opportunities, then add verified skills to your profile as you build them.</p>` : `<p class="analytics-empty">${Number(data.matching_opportunities) ? "Your profile already covers the required skills listed for eligible opportunities." : "No eligible active opportunities with required skills are available to compare yet."}</p>`}</section>
          </div>`;
      } else if (role === "recruiter") {
        const statusRows = (data.application_statuses || []).filter(row => Number(row.count) > 0).map(row => ({ ...row, status: applicationStatusLabel(row.status) }));
        const listings = data.listing_performance || [];
        main.innerHTML = `
          <div class="page-heading analytics-heading"><div><span class="eyebrow">ORGANIZATION PERFORMANCE</span><h1>Analytics & Insights</h1><p>Hiring activity across your organization’s recruiter-owned listings.</p></div><button class="btn btn-outline" onclick="window.jobMatcher.loadView('recruiter-applicants')"><i data-lucide="users"></i> Review applicants</button></div>
          <div class="metrics-grid analytics-kpis">${analyticsMetric("TOTAL LISTINGS", summary.total_listings, "Recruiter-owned opportunities", "briefcase-business")}${analyticsMetric("ACTIVE LISTINGS", summary.active_listings, "Published and accepting applications", "radio")}${analyticsMetric("APPLICATIONS", summary.total_applications, "Across your listings", "files")}${analyticsMetric("UNIQUE APPLICANTS", summary.unique_applicants, "Distinct candidate profiles", "users-round")}${analyticsMetric("SHORTLISTED", summary.shortlisted, "Applicants advanced", "star")}${analyticsMetric("INTERVIEWS", summary.interviews, "At interview stage", "messages-square")}</div>
          <div class="analytics-grid">${analyticsBars("Application status", "Distribution across your organization’s opportunities", statusRows, "status", "count")}${analyticsBars("Application activity", "Monthly submissions to your organization", data.application_activity || [], "month", "count")}
            <section class="panel analytics-panel analytics-listings"><div class="panel-head"><div><h3>Listing performance</h3><p>Applicant totals and outcomes by opportunity</p></div><button class="btn btn-soft btn-sm" onclick="window.jobMatcher.loadView('recruiter-jobs')">Manage listings</button></div>${listings.length ? `<div class="analytics-table-wrap"><table class="analytics-table"><thead><tr><th>Opportunity</th><th>Status</th><th>Applicants</th><th>Shortlisted</th><th>Interviews</th><th>Selected</th></tr></thead><tbody>${listings.map(item => `<tr><td>${esc(item.title)}</td><td><span class="status-pill ${esc(item.status)}">${esc(item.status)}</span></td><td>${Number(item.applicants) || 0}</td><td>${Number(item.shortlisted) || 0}</td><td>${Number(item.interviews) || 0}</td><td>${Number(item.selected) || 0}</td></tr>`).join("")}</tbody></table></div>` : `<p class="analytics-empty">No recruiter-owned listings are available to report yet.</p>`}</section>
          </div>`;
      } else {
        const statusRows = (data.application_statuses || []).filter(row => Number(row.count) > 0).map(row => ({ ...row, status: applicationStatusLabel(row.status) }));
        main.innerHTML = `
          <div class="page-heading analytics-heading"><div><span class="eyebrow">PLATFORM HEALTH</span><h1>Analytics & Insights</h1><p>Platform-wide aggregates for accounts, opportunities, and application activity.</p></div><button class="btn btn-outline" onclick="window.jobMatcher.loadView('dev-applications')"><i data-lucide="clipboard-list"></i> Applications audit</button></div>
          <div class="metrics-grid analytics-kpis">${analyticsMetric("TOTAL USERS", summary.total_users, "All platform accounts", "users-round")}${analyticsMetric("CANDIDATES", summary.candidates, "Candidate accounts", "graduation-cap")}${analyticsMetric("RECRUITERS", summary.recruiters, "Recruiter accounts", "briefcase-business")}${analyticsMetric("ORGANIZATIONS", summary.organizations, "Registered companies", "building-2")}${analyticsMetric("OPPORTUNITIES", summary.total_opportunities, "Across all lifecycle states", "layers-3")}${analyticsMetric("ACTIVE OPPORTUNITIES", summary.active_opportunities, "Published and within deadline", "radio")}${analyticsMetric("APPLICATIONS", summary.total_applications, "Recorded submissions", "files")}</div>
          <div class="analytics-grid">${analyticsBars("Application status", "Current platform applications by workflow state", statusRows, "status", "count")}${analyticsBars("Application funnel", "Platform-wide application progression", data.application_funnel || [], "stage", "count")}${analyticsBars("User growth", "New accounts by month, based on account creation dates", data.user_growth || [], "month", "count")}${analyticsBars("Opportunity categories", "Catalog volume by stored opportunity category", data.opportunity_categories || [], "category", "count")}</div>`;
      }
      refreshIcons();
    } catch (error) {
      $("#main-content").innerHTML = `<div class="panel analytics-error"><span class="eyebrow">ANALYTICS</span><h1>Insights are unavailable</h1><p class="muted">${esc(error.message || "We could not load the analytics data.")}</p>${retry}</div>`;
    }
  }

  // --------------------------------------------------------------------------
  // RECRUITER VIEWS
  // --------------------------------------------------------------------------
  async function renderRecruiterDashboard() {
    try {
      const [compData, jobsData, appsData] = await Promise.all([
        api("/recruiter/company"),
        api("/recruiter/jobs"),
        api("/recruiter/applicants")
      ]);

      const jobs = jobsData.jobs || [];
      const apps = appsData.applicants || [];
      const shortlistedCount = apps.filter(a => a.current_status === "shortlisted").length;
      const pendingReviewCount = apps.filter(a => a.current_status === "submitted" || a.current_status === "under_review").length;
      const jobLifecycleCounts = {
        active: jobs.filter(job => (job.lifecycle_status || job.status) === "published").length,
        draft: jobs.filter(job => job.status === "draft").length,
        expired: jobs.filter(job => job.lifecycle_status === "expired").length,
        closed: jobs.filter(job => job.status === "closed").length
      };

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>Recruiter Workspace — ${esc(compData.company.name)}</h1>
            <p>Manage job requisitions, evaluate candidate profiles & CVs, and track applicants. Company status: <span class="status-pill ${esc(compData.company.status || 'unknown')}">${esc(compData.company.status || 'unknown')}</span></p>
          </div>
          <div class="heading-actions">
            <button class="btn btn-primary" onclick="window.jobMatcher.loadView('post-job')">
              <i data-lucide="plus-circle"></i> Post New Job Opening
            </button>
          </div>
        </div>

        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-icon blue"><i data-lucide="briefcase"></i></div>
            <div>
              <span class="metric-label">COMPANY OPENINGS</span>
              <div class="metric-value">${jobs.length}</div>
              <span class="metric-foot">Posted for ${esc(compData.company.name)}</span>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-icon green"><i data-lucide="users"></i></div>
            <div>
              <span class="metric-label">TOTAL APPLICANTS</span>
              <div class="metric-value">${apps.length}</div>
              <span class="metric-foot">Candidates applied</span>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-icon gold"><i data-lucide="clock"></i></div>
            <div>
              <span class="metric-label">PENDING REVIEWS</span>
              <div class="metric-value">${pendingReviewCount}</div>
              <span class="metric-foot">Requires attention</span>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-icon purple"><i data-lucide="award"></i></div>
            <div>
              <span class="metric-label">SHORTLISTED</span>
              <div class="metric-value">${shortlistedCount}</div>
              <span class="metric-foot">Moved to next interview stage</span>
            </div>
          </div>
        </div>

        <div class="panel" style="margin-bottom:20px;">
          <div class="panel-head">
            <div>
              <h3>Opportunity pipeline</h3>
              <p>Current lifecycle across your company postings</p>
            </div>
            <button class="btn btn-soft btn-sm" onclick="window.jobMatcher.loadView('recruiter-jobs')">Manage openings</button>
          </div>
          <div class="metrics-grid" style="margin-bottom:0;">
            ${[
              ["Active", jobLifecycleCounts.active, "green"],
              ["Draft", jobLifecycleCounts.draft, "blue"],
              ["Expired", jobLifecycleCounts.expired, "gold"],
              ["Closed", jobLifecycleCounts.closed, "purple"]
            ].map(([label, count, color]) => `
              <div class="metric-card">
                <div class="metric-icon ${color}"><i data-lucide="${label === "Active" ? "circle-check" : label === "Expired" ? "calendar" : label === "Draft" ? "file-text" : "x-circle"}"></i></div>
                <div><span class="metric-label">${label.toUpperCase()}</span><div class="metric-value">${count}</div></div>
              </div>
            `).join("")}
          </div>
          ${jobs.length === 0 ? `<p class="muted" style="margin:12px 0 0;">No opportunities posted yet. Create your first opening to start receiving candidates.</p>` : ""}
        </div>

        <div class="panel">
          <div class="panel-head">
            <div>
              <h3>Recent Candidates for Your Company</h3>
              <p>Applicants who applied to your open postings</p>
            </div>
            <button class="btn btn-soft btn-sm" onclick="window.jobMatcher.loadView('recruiter-applicants')">
              View All Applicants <i data-lucide="arrow-right"></i>
            </button>
          </div>
          ${apps.length === 0 ? `
            <p class="muted" style="text-align:center;padding:30px;">No candidates have applied to your postings yet.</p>
          ` : `
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Job Position</th>
                    <th>Applied Date</th>
                    <th>Skills Profile</th>
                    <th>Current Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${apps.slice(0, 5).map(a => `
                    <tr>
                      <td>
                        <b>${esc(a.candidate_name)}</b>
                        <small style="color:#78869c;display:block;">${esc(a.candidate_email || '')}</small>
                      </td>
                      <td><b>${esc(a.job_title)}</b></td>
                      <td>${formatDate(a.applied_at)}</td>
                      <td>
                        <div class="skill-chips">
                          ${(a.candidate_skills || []).slice(0, 3).map(s => `
                            <span class="skill-chip">${esc(s.skill)}</span>
                          `).join("")}
                        </div>
                      </td>
                      <td>
                        <span class="status-pill ${esc(a.current_status)}">${applicationStatusLabel(a.current_status)}</span>
                      </td>
                      <td>
                        <button class="btn btn-outline btn-sm" onclick="window.jobMatcher.openStatusModal(${a.application_id}, '${a.current_status}')">
                          Update Status
                        </button>
                      </td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          `}
        </div>
      `;
      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load recruiter workspace: ${esc(e.message)}</p></div>`;
    }
  }

  async function renderPostJobForm() {
    try {
      const skillsData = await api("/skills");
      masterSkills = skillsData.skills || [];

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>Post New Job Opening</h1>
            <p>Publish opportunities with clear requirements, work modes, and application deadlines.</p>
          </div>
        </div>

        <div class="panel" style="max-width:850px;">
          <form id="create-job-form" class="form-grid">
            <div class="form-field full">
              <label>Job Title</label>
              <input class="form-input" name="title" placeholder="e.g. Senior Backend Engineer — Python & Cloud" required />
            </div>

            <div class="form-field">
              <label>Job Type</label>
              <select class="form-select" name="job_type">
                <option value="Full-time">Full-time</option>
                <option value="Internship">Internship</option>
                <option value="Part-time">Part-time</option>
                <option value="Contract">Contract</option>
              </select>
            </div>

            <div class="form-field">
              <label>Opportunity Category</label>
              <select class="form-select" name="opportunity_category">
                ${[['job','Job'],['internship','Internship'],['hackathon','Hackathon'],['project','Project'],['open_source','Open source'],['research','Research'],['scholarship','Scholarship'],['fellowship','Fellowship'],['competition','Competition'],['workshop','Workshop'],['developer_program','Developer program'],['startup','Startup'],['apprenticeship','Apprenticeship'],['certification','Certification']].map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}
              </select>
            </div>

            <div class="form-field"><label>Experience Level</label><select class="form-select" name="experience_level"><option>Student</option><option>Fresher</option><option>Beginner</option><option>Intermediate</option><option>Advanced</option></select></div>
            <div class="form-field"><label>Compensation Type</label><select class="form-select" name="paid_status"><option value="paid">Paid</option><option value="stipend">Stipend</option><option value="unpaid">Unpaid</option><option value="prize">Prize</option><option value="none">None</option></select></div>

            <div class="form-field">
              <label>Work Mode</label>
              <select class="form-select" name="work_mode">
                <option value="Remote">Remote</option>
                <option value="Hybrid" selected>Hybrid</option>
                <option value="On-site">On-site</option>
              </select>
            </div>

            <div class="form-field">
              <label>Location (City, Country)</label>
              <input class="form-input" name="location" placeholder="e.g. Bengaluru, India" required />
            </div>

            <div class="form-field">
              <label>Application Deadline</label>
              <input class="form-input" type="date" name="deadline" required />
            </div>

            <div class="form-field">
              <label>Minimum Compensation (₹ INR)</label>
              <input class="form-input" type="number" step="10000" name="salary_min" placeholder="0" />
            </div>

            <div class="form-field">
              <label>Maximum Compensation (₹ INR)</label>
              <input class="form-input" type="number" step="10000" name="salary_max" placeholder="0" />
            </div>

            <div class="form-field full">
              <label>Job Description & Responsibilities</label>
              <textarea class="form-textarea" name="description" placeholder="Describe the day-to-day role and team focus..." required></textarea>
            </div>

            <div class="form-field full">
              <label>Additional Requirements</label>
              <textarea class="form-textarea" name="requirements" placeholder="Qualifications, years of experience, or degree prerequisites..."></textarea>
            </div>

            <div class="form-field full"><label>Eligibility</label><textarea class="form-textarea" name="eligibility" placeholder="Who is eligible to apply?"></textarea></div>
            <div class="form-field"><label>Start Date (optional)</label><input class="form-input" type="date" name="start_date"></div>
            <div class="form-field"><label>Duration (optional)</label><input class="form-input" name="duration" maxlength="100" placeholder="e.g. 12 weeks"></div>
            <div class="form-field"><label>Number of Positions (optional)</label><input class="form-input" type="number" name="positions" min="1" step="1"></div>
            <div class="form-field"><label>External Application URL (optional)</label><input class="form-input" type="url" name="application_url" placeholder="https://..."></div>

            <!-- Required and optional skills -->
            <div class="form-field full" style="border-top:1px solid #edf0f5;padding-top:14px;">
              <label>Opportunity Skills (required skills count more in matching):</label>
              <input id="create-skill-search" class="form-input" placeholder="Search skills" style="width:100%;margin:8px 0;">
              <div id="create-skill-list" style="display:grid;grid-template-columns:1fr;gap:8px;max-height:230px;overflow:auto;padding:10px;border:1px solid #e1e7f0;border-radius:10px;background:#fcfdfe;">
                ${masterSkills.map(s => `
                  <label data-create-skill-row data-name="${esc(s.name.toLowerCase())}" style="display:grid;grid-template-columns:minmax(140px,1fr) 130px 150px;align-items:center;gap:8px;font-size:11px;">
                    <span>${esc(s.name)} <small class="muted">${esc(s.category || '')}</small></span>
                    <select class="form-select" data-create-kind="${s.id}"><option value="">Not selected</option><option value="required">Required</option><option value="optional">Optional</option></select>
                    <select class="form-select" data-create-level="${s.id}">${['Beginner','Intermediate','Advanced','Expert'].map(level=>`<option value="${level}" ${level==='Intermediate'?'selected':''}>Min ${level}</option>`).join('')}</select>
                  </label>
                `).join("")}
              </div>
            </div>

            <div class="form-field"><label>Initial Status</label><select class="form-select" name="status"><option value="published">Publish now</option><option value="draft">Save as draft</option></select></div>

            <div class="form-field full" style="margin-top:14px;display:flex;justify-content:flex-end;gap:10px;">
              <button type="button" class="btn btn-outline" onclick="window.jobMatcher.loadView('recruiter-jobs')">Cancel</button>
              <button type="submit" class="btn btn-primary"><i data-lucide="check-circle"></i> Save Opportunity</button>
            </div>
          </form>
        </div>
      `;

      // Set default deadline to 30 days in future
      const d = new Date();
      d.setDate(d.getDate() + 30);
      $('input[name="deadline"]').value = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      $('input[name="deadline"]').min = `${new Date().getFullYear()}-${String(new Date().getMonth()+1).padStart(2,'0')}-${String(new Date().getDate()).padStart(2,'0')}`;

      $("#create-job-form").addEventListener("submit", async e => {
        e.preventDefault();
        const form = e.currentTarget;
        const fd = new FormData(form);
        const submit = e.submitter;
        const selectedSkills = $$('[data-create-skill-row]').flatMap(row => {
          const classification = $('[data-create-kind]', row).value;
          return classification ? [{
            skill_id: Number($('[data-create-kind]', row).dataset.createKind),
            is_required: classification === 'required',
            min_proficiency: $('[data-create-level]', row).value
          }] : [];
        });

        const body = {
          title: fd.get("title"),
          job_type: fd.get("job_type"),
          work_mode: fd.get("work_mode"),
          location: fd.get("location"),
          deadline: fd.get("deadline"),
          salary_min: Number(fd.get("salary_min")) || 0,
          salary_max: Number(fd.get("salary_max")) || 0,
          description: fd.get("description"),
          requirements: fd.get("requirements"),
          opportunity_category: fd.get("opportunity_category"),
          experience_level: fd.get("experience_level"),
          paid_status: fd.get("paid_status"),
          eligibility: fd.get("eligibility"),
          start_date: fd.get("start_date") || null,
          duration: fd.get("duration"),
          application_url: fd.get("application_url"),
          positions: fd.get("positions") || null,
          status: fd.get("status"),
          skill_ids: selectedSkills
        };

        if (submit) { submit.disabled = true; submit.textContent = "Saving…"; }
        try {
          const result = await api("/recruiter/jobs", { method: "POST", body: JSON.stringify(body) });
          toast(result.message || "Opportunity saved.");
          loadView("recruiter-jobs");
        } catch (err) {
          toast(err.message, true);
          if (submit) { submit.disabled = false; submit.innerHTML = '<i data-lucide="check-circle"></i> Save Opportunity'; refreshIcons(); }
        }
      });

      $('#create-skill-search').addEventListener('input', e => {
        const value = e.target.value.trim().toLowerCase();
        $$('[data-create-skill-row]').forEach(row => row.classList.toggle('hidden', !row.dataset.name.includes(value)));
      });

      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load job creation form: ${esc(e.message)}</p></div>`;
    }
  }

  async function renderRecruiterJobsList() {
    try {
      const data = await api("/recruiter/jobs");
      const jobs = data.jobs || [];

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>Company Job Postings</h1>
            <p>Active and closed opportunities belonging to your company.</p>
          </div>
          <div class="heading-actions">
            <button class="btn btn-primary" onclick="window.jobMatcher.loadView('post-job')">
              <i data-lucide="plus-circle"></i> Post New Job
            </button>
          </div>
        </div>

        ${jobs.length === 0 ? `
          <div class="panel" style="text-align:center;padding:40px;">
            <p class="muted">No job postings created yet.</p>
            <button class="btn btn-primary" onclick="window.jobMatcher.loadView('post-job')">Post Opening</button>
          </div>
        ` : `
          <div class="panel">
            <div class="table-wrap">
              <table class="data-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Type / Mode</th>
                    <th>Location</th>
                    <th>Applicants</th>
                    <th>Deadline</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${jobs.map(j => `
                    <tr>
                      <td><b>${esc(j.title)}</b></td>
                      <td>${esc(j.job_type)} · ${esc(j.work_mode)}</td>
                      <td>${esc(j.location)}</td>
                      <td>
                        <span class="match-score-pill medium">${j.applicant_count} Applicants</span>
                      </td>
                      <td>${formatDate(j.deadline)}</td>
                      <td>
                        <span class="status-pill ${j.lifecycle_status || j.status}">${esc(j.lifecycle_status || j.status)}</span>
                        ${j.days_remaining != null ? `<small>${j.days_remaining} day(s) remaining</small>` : ''}
                      </td>
                      <td>
                        <div style="display:flex;gap:6px;">
                          <button class="btn btn-outline btn-sm" onclick="window.jobMatcher.editJob(${j.id})">Edit</button>
                          ${(j.lifecycle_status || j.status) === 'expired' ? `
                            <button class="btn btn-soft btn-sm" onclick="window.jobMatcher.renewJob(${j.id})">Renew with new deadline</button>
                          ` : (j.lifecycle_status || j.status) === 'published' ? `
                            <button class="btn btn-outline btn-sm" onclick="window.jobMatcher.toggleJobStatus(${j.id}, 'closed')">Close</button>
                          ` : j.status === 'draft' || j.status === 'closed' ? `
                            <button class="btn btn-soft btn-sm" onclick="window.jobMatcher.toggleJobStatus(${j.id}, 'published')">Publish</button>
                          ` : `
                            <span class="muted">Unavailable</span>
                          `}
                        </div>
                      </td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          </div>
        `}
      `;
      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load jobs: ${esc(e.message)}</p></div>`;
    }
  }

  async function renderRecruiterApplicants(filters = {}) {
    try {
      const qs = new URLSearchParams(Object.entries(filters).filter(([,v]) => v));
      const data = await api(`/recruiter/applicants${qs.toString() ? `?${qs}` : ''}`);
      const applicants = data.applicants || [];
      const counts = data.status_counts || {};
      const total = Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);
      const applicationStatuses = ["submitted", "under_review", "shortlisted", "interview", "selected", "rejected", "withdrawn"];

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>Candidate Applicants</h1>
            <p>Review candidate profiles, technical competencies, uploaded CVs, and advance hiring stages.</p>
          </div>
        </div>

        <div class="metrics-grid application-metrics">
          <div class="metric-card"><div class="metric-icon blue"><i data-lucide="users"></i></div><div><span class="metric-label">TOTAL APPLICANTS</span><div class="metric-value">${total}</div><span class="metric-foot">Across your opportunities</span></div></div>
          <div class="metric-card"><div class="metric-icon gold"><i data-lucide="inbox"></i></div><div><span class="metric-label">NEW</span><div class="metric-value">${Number(counts.submitted || 0)}</div><span class="metric-foot">Awaiting first review</span></div></div>
          <div class="metric-card"><div class="metric-icon green"><i data-lucide="star"></i></div><div><span class="metric-label">SHORTLISTED</span><div class="metric-value">${Number(counts.shortlisted || 0)}</div><span class="metric-foot">In your active pipeline</span></div></div>
          <div class="metric-card"><div class="metric-icon purple"><i data-lucide="messages-square"></i></div><div><span class="metric-label">INTERVIEWS</span><div class="metric-value">${Number(counts.interview || 0)}</div><span class="metric-foot">Interview stage</span></div></div>
          <div class="metric-card"><div class="metric-icon gold"><i data-lucide="eye"></i></div><div><span class="metric-label">UNDER REVIEW</span><div class="metric-value">${Number(counts.under_review || 0)}</div><span class="metric-foot">Currently being evaluated</span></div></div>
          <div class="metric-card"><div class="metric-icon green"><i data-lucide="badge-check"></i></div><div><span class="metric-label">SELECTED</span><div class="metric-value">${Number(counts.selected || 0)}</div><span class="metric-foot">Successful outcomes</span></div></div>
          <div class="metric-card"><div class="metric-icon purple"><i data-lucide="circle-x"></i></div><div><span class="metric-label">REJECTED</span><div class="metric-value">${Number(counts.rejected || 0)}</div><span class="metric-foot">Closed applications</span></div></div>
        </div>

        <form id="applicant-filters" class="panel form-grid" style="margin-bottom:16px">
          <div class="form-field"><label for="filter-applicant-name">Candidate</label><input id="filter-applicant-name" name="search" class="form-input" placeholder="Search candidate" value="${esc(filters.search || '')}"></div>
          <div class="form-field"><label for="filter-applicant-job">Opportunity</label><select id="filter-applicant-job" name="job_id" class="form-select"><option value="">All your opportunities</option>${(data.opportunities || []).map(job => `<option value="${Number(job.job_id)}" ${String(filters.job_id || '') === String(job.job_id) ? 'selected' : ''}>${esc(job.job_title)}</option>`).join('')}</select></div>
          <div class="form-field"><label for="filter-applicant-skill">Skill</label><input id="filter-applicant-skill" name="skill" class="form-input" placeholder="e.g. Python" value="${esc(filters.skill || '')}"></div>
          <div class="form-field"><label for="filter-applicant-status">Status</label><select id="filter-applicant-status" name="status" class="form-select"><option value="">All statuses</option>${applicationStatuses.map(status => `<option value="${status}" ${filters.status === status ? 'selected' : ''}>${applicationStatusLabel(status)}</option>`).join('')}</select></div>
          <div class="form-field"><label>Experience</label><input name="experience" class="form-input" placeholder="Role, organization, keyword"></div><div class="form-field"><label>Education</label><input name="education" class="form-input" placeholder="Degree, branch, institution"></div><label><input type="checkbox" name="has_experience" value="true"> Has experience</label><button class="btn btn-primary">Apply filters</button>
        </form>

        ${applicants.length === 0 ? `
          <div class="panel" style="text-align:center;padding:50px;">
            <i data-lucide="users" style="width:40px;height:40px;color:#9aa7bc;margin-bottom:12px;"></i>
            <h3>No Applicants Yet</h3>
            <p class="muted">As candidates apply to your company's jobs, their full profiles will appear here.</p>
          </div>
        ` : `
          <div style="display:grid;gap:16px;">
            ${applicants.map(a => `
              <div class="panel">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:12px;">
                  <div>
                    <h3 style="font-size:15px;margin:0 0 4px;">${esc(a.candidate_name)}</h3>
                    <p style="font-size:11px;color:#707f96;margin:0;">
                      Applied for: <b>${esc(a.job_title)}</b> · Location: ${esc(a.candidate_location || 'Not specified')} · Applied: ${formatDate(a.applied_at)}
                    </p>
                  </div>
                  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                    <span class="status-pill ${esc(a.current_status)}">${applicationStatusLabel(a.current_status)}</span>
                    ${nextRecruiterStatuses(a.current_status).length ? `<button class="btn btn-primary btn-sm" onclick="window.jobMatcher.openStatusModal(${Number(a.application_id)}, '${esc(a.current_status)}')">Update Status</button>` : '<span class="muted" style="font-size:10px;">Final status</span>'}
                  </div>
                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;background:#f8fafd;border:1px solid #edf1f7;border-radius:10px;padding:12px 14px;margin-bottom:12px;font-size:11px;">
                  <div>
                    <span style="font-weight:700;color:#6b7c97;display:block;margin-bottom:4px;">CONTACT DETAILS:</span>
                    <span>Email: <a href="mailto:${esc(a.candidate_email)}" style="color:#3158ce;">${esc(a.candidate_email || 'N/A')}</a></span><br/>
                    <span>Phone: ${esc(a.candidate_phone || 'N/A')}</span>
                  </div>
                  <div>
                    <span style="font-weight:700;color:#6b7c97;display:block;margin-bottom:4px;">ATTACHED RESUME / CV:</span>
                    ${a.resume_file_path ? `
                      <a href="/${esc(a.resume_file_path)}" target="_blank" class="btn btn-outline btn-sm" style="display:inline-flex;align-items:center;gap:6px;">
                        <i data-lucide="download"></i> Download ${esc(a.resume_file_name || 'Resume')}
                      </a>
                    ` : `<span class="muted">No CV attached</span>`}
                  </div>
                </div>

                ${a.cover_letter ? `
                  <div style="font-size:11px;color:#505e74;margin-bottom:12px;">
                    <b>Candidate Note:</b> "${esc(a.cover_letter)}"
                  </div>
                ` : ''}

                <details style="margin:12px 0"><summary style="cursor:pointer;font-weight:700">View full candidate profile</summary>
                  <p>${esc(a.candidate_bio || 'No profile summary provided.')}</p>
                  <h4>Education</h4>${(a.education||[]).map(x=>`<p>${esc(x.degree)} · ${esc(x.field_of_study||'')} — ${esc(x.institution)} (${esc(x.start_year||'')}–${esc(x.end_year||'Present')})</p>`).join('')||'<p class="muted">No education listed.</p>'}
                  <h4>Experience</h4>${(a.experience||[]).map(x=>`<p><b>${esc(x.role_title)}</b> · ${esc(x.company_name)} (${formatDate(x.start_date)}–${x.is_current?'Present':formatDate(x.end_date)})<br>${esc(x.description||'')}</p>`).join('')||'<p class="muted">No experience listed.</p>'}
                  <h4>Achievements</h4>${(a.achievements||[]).map(x=>`<p><b>${esc(x.title)}</b> · ${esc(x.issuer||'')} · ${formatDate(x.issue_date)}<br>${esc(x.description||'')}</p>`).join('')||'<p class="muted">No achievements listed.</p>'}
                  <h4>Application status history</h4>${(a.status_history||[]).map(h=>`<p><span class="status-pill ${esc(h.status)}">${h.previous_status?`${applicationStatusLabel(h.previous_status)} → `:''}${applicationStatusLabel(h.status)}</span> · ${formatDate(h.changed_at)}${h.changed_by?` · ${esc(h.changed_by)}`:''}${h.notes?`<br>${esc(h.notes)}`:''}</p>`).join('')||'<p class="muted">No status history available.</p>'}
                </details>

                <div>
                  <span style="font-size:10px;font-weight:700;color:#6b7c97;display:block;margin-bottom:6px;">DECLARED TECHNICAL SKILLS:</span>
                  <div class="skill-chips">
                    ${(a.candidate_skills || []).map(s => `
                      <span class="skill-chip match">${esc(s.skill)} (${esc(s.proficiency || 'Intermediate')})</span>
                    `).join("")}
                  </div>
                </div>
              </div>
            `).join("")}
          </div>
        `}
      `;
      $('#applicant-filters').addEventListener('submit', e => { e.preventDefault(); const fd=new FormData(e.currentTarget); renderRecruiterApplicants({search:fd.get('search'),job_id:fd.get('job_id'),skill:fd.get('skill'),status:fd.get('status'),has_experience:fd.get('has_experience'),experience:fd.get('experience'),education:fd.get('education')}); });
      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load applicants: ${esc(e.message)}</p></div>`;
    }
  }

  async function renderRecruiterCompanyProfile() {
    try {
      const data = await api("/recruiter/company");
      const c = data.company || {};
      const r = data.recruiter || {};

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>Company Profile</h1>
            <p>Your organization's registered credentials and verification status.</p>
          </div>
        </div>

        <div class="panel" style="max-width:700px;">
          <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;">
            <div class="company-badge" style="width:54px;height:54px;font-size:20px;">${esc(c.name.substring(0, 2).toUpperCase())}</div>
            <div>
              <h2 style="font-size:18px;margin:0 0 4px;">${esc(c.name)}</h2>
              <span class="status-pill ${c.status}">${esc(c.status)}</span>
            </div>
          </div>

          <div style="display:grid;gap:12px;font-size:12px;">
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid #f0f3f7;padding-bottom:8px;">
              <span class="muted">Industry Sector:</span>
              <b>${esc(c.industry || 'Not specified')}</b>
            </div>
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid #f0f3f7;padding-bottom:8px;">
              <span class="muted">Headquarters / Location:</span>
              <b>${esc(c.location || 'Not specified')}</b>
            </div>
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid #f0f3f7;padding-bottom:8px;">
              <span class="muted">Website:</span>
              <a href="${esc(c.website)}" target="_blank" style="color:#3158ce;">${esc(c.website || 'N/A')}</a>
            </div>
            <div style="display:flex;justify-content:space-between;border-bottom:1px solid #f0f3f7;padding-bottom:8px;">
              <span class="muted">Recruiter Lead:</span>
              <b>${esc(r.full_name)} (${esc(r.designation || 'Recruiter')})</b>
            </div>
          </div>

          <div style="margin-top:20px;">
            <span class="muted" style="font-size:11px;font-weight:700;">COMPANY OVERVIEW:</span>
            <p style="font-size:12px;color:#526075;line-height:1.7;margin-top:6px;">
              ${esc(c.description || 'No description provided.')}
            </p>
          </div>
        </div>
      `;
      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load company profile: ${esc(e.message)}</p></div>`;
    }
  }

  // --------------------------------------------------------------------------
  // PLATFORM ADMINISTRATION VIEWS
  // --------------------------------------------------------------------------
  async function renderDeveloperDashboard() {
    try {
      const data = await api("/developer/stats");
      const m = data.metrics || {};
      const applicationBreakdown = data.applications_breakdown || [];
      const recentCompanies = data.recent_companies || [];
      const recentOpportunities = data.recent_opportunities || [];
      const recentApplications = data.recent_applications || [];
      const recentAdminActions = data.recent_admin_actions || [];

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>Platform overview</h1>
            <p>Monitor activity, review organizations, and support a trusted opportunity community.</p>
          </div>
          <div class="heading-actions">
            <button class="btn btn-primary" onclick="window.jobMatcher.loadView('dev-pending')">
              <i data-lucide="clock"></i> Review Pending Companies (${m.pending_companies || 0})
            </button>
          </div>
        </div>

        <div class="metrics-grid">
          <div class="metric-card">
            <div class="metric-icon blue"><i data-lucide="users"></i></div>
            <div>
              <span class="metric-label">CANDIDATES</span>
              <div class="metric-value">${m.total_users || 0}</div>
              <span class="metric-foot">Student accounts</span>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-icon green"><i data-lucide="briefcase"></i></div>
            <div>
              <span class="metric-label">RECRUITERS</span>
              <div class="metric-value">${m.total_recruiters || 0}</div>
              <span class="metric-foot">Employer accounts</span>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-icon gold"><i data-lucide="clock"></i></div>
            <div>
              <span class="metric-label">PENDING APPROVALS</span>
              <div class="metric-value">${m.pending_companies || 0}</div>
              <span class="metric-foot">Awaiting developer review</span>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-icon purple"><i data-lucide="database"></i></div>
            <div>
              <span class="metric-label">TOTAL APPLICATIONS</span>
              <div class="metric-value">${m.total_applications || 0}</div>
              <span class="metric-foot">Platform wide</span>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-icon blue"><i data-lucide="building-2"></i></div>
            <div>
              <span class="metric-label">COMPANIES</span>
              <div class="metric-value">${m.total_companies || 0}</div>
              <span class="metric-foot">Registered organizations</span>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-icon green"><i data-lucide="check-circle"></i></div>
            <div>
              <span class="metric-label">APPROVED COMPANIES</span>
              <div class="metric-value">${m.approved_companies || 0}</div>
              <span class="metric-foot">Verified for recruiting</span>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-icon purple"><i data-lucide="briefcase"></i></div>
            <div>
              <span class="metric-label">OPPORTUNITIES</span>
              <div class="metric-value">${m.total_jobs || 0}</div>
              <span class="metric-foot">All lifecycle states</span>
            </div>
          </div>
          <div class="metric-card">
            <div class="metric-icon gold"><i data-lucide="briefcase"></i></div>
            <div>
              <span class="metric-label">ACTIVE OPPORTUNITIES</span>
              <div class="metric-value">${m.active_jobs || 0}</div>
              <span class="metric-foot">Published and in deadline</span>
            </div>
          </div>
          <div class="metric-card"><div class="metric-icon blue"><i data-lucide="shield"></i></div><div><span class="metric-label">ADMIN ACCOUNTS</span><div class="metric-value">${m.developers || 0}</div><span class="metric-foot">Developer role</span></div></div>
          <div class="metric-card"><div class="metric-icon gold"><i data-lucide="building"></i></div><div><span class="metric-label">REJECTED COMPANIES</span><div class="metric-value">${m.rejected_companies || 0}</div><span class="metric-foot">Not approved for recruiting</span></div></div>
          <div class="metric-card"><div class="metric-icon blue"><i data-lucide="file-text"></i></div><div><span class="metric-label">DRAFT OPPORTUNITIES</span><div class="metric-value">${m.draft_opportunities || 0}</div></div></div>
          <div class="metric-card"><div class="metric-icon purple"><i data-lucide="circle-x"></i></div><div><span class="metric-label">CLOSED OPPORTUNITIES</span><div class="metric-value">${m.closed_opportunities || 0}</div></div></div>
          <div class="metric-card"><div class="metric-icon gold"><i data-lucide="calendar-x"></i></div><div><span class="metric-label">EXPIRED OPPORTUNITIES</span><div class="metric-value">${m.expired_opportunities || 0}</div></div></div>
        </div>

        <div class="panel" style="margin:20px 0;">
          <div class="panel-head"><div><h3>Recent platform activity</h3><p>Recent registrations, opportunities, applications, and reviews</p></div></div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;">
            <section><b>Company registrations</b>${recentCompanies.length ? recentCompanies.map(x=>`<p class="muted" style="margin:8px 0">${esc(x.name)} · ${esc(x.status)}<br><small>${formatDate(x.created_at)}${x.recruiter_name?` · ${esc(x.recruiter_name)}`:''}</small></p>`).join('') : '<p class="muted">No companies registered.</p>'}</section>
            <section><b>Opportunities</b>${recentOpportunities.length ? recentOpportunities.map(x=>`<p class="muted" style="margin:8px 0">${esc(x.title)} · ${esc(x.company_name)} · ${esc(x.lifecycle_status)}<br><small>${formatDate(x.created_at)}</small></p>`).join('') : '<p class="muted">No opportunities created.</p>'}</section>
            <section><b>Applications</b>${recentApplications.length ? recentApplications.map(x=>`<p class="muted" style="margin:8px 0">${esc(x.candidate_name)} → ${esc(x.opportunity_title)} · ${applicationStatusLabel(x.current_status)}<br><small>${formatDate(x.applied_at)} · ${esc(x.company_name)}</small></p>`).join('') : '<p class="muted">No applications submitted.</p>'}</section>
            <section><b>Administrative reviews</b>${recentAdminActions.length ? recentAdminActions.map(x=>`<p class="muted" style="margin:8px 0">${esc(x.event_type)} · ${esc(x.target)} · ${esc(x.detail)}<br><small>${formatDate(x.happened_at)} · ${esc(x.actor)}</small></p>`).join('') : '<p class="muted">No administrative reviews recorded yet.</p>'}</section>
          </div>
        </div>

        <div class="panel" style="margin-bottom:20px;">
          <div class="panel-head">
            <div>
              <h3>Application status overview</h3>
              <p>Current platform application totals by workflow status</p>
            </div>
            <button class="btn btn-soft btn-sm" onclick="window.jobMatcher.loadView('dev-applications')">Open application audit</button>
          </div>
          ${applicationBreakdown.length ? `
            <div class="skill-chips">
              ${applicationBreakdown.map(item => `<span class="skill-chip">${applicationStatusLabel(item.current_status || "unknown")}: ${Number(item.count) || 0}</span>`).join("")}
            </div>
          ` : `<p class="muted" style="margin:0;">No applications have been submitted yet.</p>`}
        </div>

        <!-- Quick Developer Actions Grid -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;">
          <div class="panel" style="display:flex;flex-direction:column;justify-content:space-between;">
            <div>
              <h3>Pending Company Verifications</h3>
              <p class="muted" style="margin:8px 0 16px;">Approve or reject companies that registered recently. Recruiters cannot log in until approved.</p>
            </div>
            <button class="btn btn-mint" onclick="window.jobMatcher.loadView('dev-pending')">
              Open Review Queue <i data-lucide="arrow-right"></i>
            </button>
          </div>

          <div class="panel" style="display:flex;flex-direction:column;justify-content:space-between;">
            <div>
              <h3>User Accounts Audit</h3>
              <p class="muted" style="margin:8px 0 16px;">Inspect all Candidate and Recruiter database records, emails, and creation timestamps.</p>
            </div>
            <button class="btn btn-outline" onclick="window.jobMatcher.loadView('dev-users')">
              Audit Accounts <i data-lucide="arrow-right"></i>
            </button>
          </div>

          <div class="panel" style="display:flex;flex-direction:column;justify-content:space-between;">
            <div><h3>Recruiter Company Linking</h3><p class="muted" style="margin:8px 0 16px;">Review requests before associating a recruiter with an approved company.</p></div>
            <button class="btn btn-outline" onclick="window.jobMatcher.loadView('dev-links')">Review Link Requests <i data-lucide="arrow-right"></i></button>
          </div>
          <div class="panel" style="display:flex;flex-direction:column;justify-content:space-between;">
            <div>
              <h3>Jobs & Applications Audit</h3>
              <p class="muted" style="margin:8px 0 16px;">Audit all published jobs, applicant counts, and cross-company hiring workflows.</p>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-outline" onclick="window.jobMatcher.loadView('dev-jobs')">Manage Opportunities <i data-lucide="arrow-right"></i></button><button class="btn btn-primary" onclick="window.jobMatcher.openDeveloperOpportunityForm()"><i data-lucide="plus"></i> Curate Opportunity</button></div>
          </div>
        </div>
      `;
      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load developer stats: ${esc(e.message)}</p></div>`;
    }
  }

  async function renderDeveloperPendingCompanies() {
    try {
      const data = await api("/developer/companies/pending");
      const pending = data.pending_companies || [];

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>Pending Recruiter Company Approvals</h1>
            <p>New recruiter registrations remain pending until an administrator verifies the organization.</p>
          </div>
        </div>

        ${pending.length === 0 ? `
          <div class="panel" style="text-align:center;padding:50px;">
            <i data-lucide="check-circle" style="width:40px;height:40px;color:#159b73;margin-bottom:12px;"></i>
            <h3>All Companies Reviewed</h3>
            <p class="muted">There are no pending recruiter company registrations awaiting verification.</p>
          </div>
        ` : `
          <div style="display:grid;gap:16px;">
            ${pending.map(c => `
              <div class="panel">
                <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:14px;">
                  <div>
                    <h3 style="font-size:16px;margin:0 0 4px;">${esc(c.company_name)}</h3>
                    <p style="font-size:11px;color:#78869c;margin:0;">
                      ${esc(c.industry || 'Technology')} · Location: ${esc(c.location || 'N/A')} · Registered: ${formatDate(c.created_at)}
                    </p>
                  </div>
                  <span class="status-pill pending">PENDING APPROVAL</span>
                </div>

                <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;background:#fffaf0;border:1px solid #fae6c2;border-radius:10px;padding:12px 14px;margin-bottom:14px;font-size:11px;">
                  <div>
                    <span style="font-weight:700;color:#9c6314;display:block;margin-bottom:4px;">RECRUITER APPLICANT:</span>
                    <span>Name: <b>${esc(c.recruiter_name)}</b> (${esc(c.recruiter_designation || 'Recruiter')})</span><br/>
                    <span>Username: <code>${esc(c.recruiter_username)}</code></span><br/>
                    <span>Email: ${esc(c.recruiter_email || 'N/A')} · Phone: ${esc(c.recruiter_phone || 'N/A')}</span>
                  </div>
                  <div>
                    <span style="font-weight:700;color:#9c6314;display:block;margin-bottom:4px;">ORGANIZATION DETAILS:</span>
                    <span>Website: <a href="${esc(c.website)}" target="_blank" style="color:#3158ce;">${esc(c.website || 'N/A')}</a></span><br/>
                    <p style="margin:4px 0 0;color:#6d5322;line-height:1.5;">${esc(c.description || 'No description provided.')}</p>
                  </div>
                </div>

                <div style="display:flex;justify-content:flex-end;gap:10px;">
                  <button class="btn btn-danger" onclick="window.jobMatcher.reviewCompany(${c.company_id}, 'rejected')">
                    <i data-lucide="x-circle"></i> Reject Registration
                  </button>
                  <button class="btn btn-mint" onclick="window.jobMatcher.reviewCompany(${c.company_id}, 'approved')">
                    <i data-lucide="check-circle"></i> Approve Company & Activate Recruiter
                  </button>
                </div>
              </div>
            `).join("")}
          </div>
        `}
      `;
      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load pending queue: ${esc(e.message)}</p></div>`;
    }
  }

  async function renderDeveloperAllCompanies(filters = {}) {
    try {
      const companyQuery = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
      const data = await api(`/developer/companies${companyQuery.toString() ? `?${companyQuery}` : ''}`);
      const list = data.companies || [];

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>Registered Companies Audit</h1>
            <p>Complete directory of approved, pending, and rejected recruiter organizations.</p>
          </div>
        </div>

        <form id="developer-company-filters" class="panel" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">
          <input class="form-input" name="search" placeholder="Search company, recruiter, or email" style="flex:1;min-width:220px;" value="${esc(filters.search || '')}">
          <select class="form-select" name="status" style="min-width:150px;">
            <option value="">All statuses</option>${['pending','approved','rejected'].map(s => `<option value="${s}" ${filters.status===s?'selected':''}>${s}</option>`).join('')}
          </select>
          <button type="submit" class="btn btn-primary">Filter companies</button>
          <button type="button" class="btn btn-outline" onclick="window.jobMatcher.loadView('dev-links')">Link requests</button>
        </form>

        <div class="panel">
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Industry</th>
                  <th>Location</th>
                  <th>Jobs Posted</th>
                  <th>Status</th>
                  <th>Reviewed By</th>
                  <th>Recruiters</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${list.map(c => `
                  <tr>
                    <td><b>${esc(c.name)}</b></td>
                    <td>${esc(c.industry || 'N/A')}</td>
                    <td>${esc(c.location || 'N/A')}</td>
                    <td>${c.jobs_count} Jobs</td>
                    <td><span class="status-pill ${c.status}">${esc(c.status)}</span></td>
                    <td>${c.reviewer_username ? `@${esc(c.reviewer_username)} (${formatDate(c.reviewed_at)})` : 'None'}</td>
                    <td>${(c.recruiters || []).map(r => `${esc(r.full_name)} (@${esc(r.username)})`).join('<br>') || '—'}</td>
                    <td>
                      <button class="btn btn-outline btn-sm" onclick="window.jobMatcher.openDeveloperCompanyDetails(${c.id})">Details</button>
                      ${c.status === 'pending' ? `
                        <button class="btn btn-mint btn-sm" onclick="window.jobMatcher.reviewCompany(${c.id}, 'approved')">Approve</button>
                      ` : ''}
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;
      $('#developer-company-filters').onsubmit = e => { e.preventDefault(); const fd=new FormData(e.currentTarget); renderDeveloperAllCompanies({search:fd.get('search'),status:fd.get('status')}); };
      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load companies: ${esc(e.message)}</p></div>`;
    }
  }

  async function renderDeveloperLinkRequests(filters = {}) {
    try {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
      const data = await api(`/developer/companies/link-requests${query.toString() ? `?${query}` : ''}`);
      const requests = data.requests || [];
      $("#main-content").innerHTML = `
        <div class="page-heading"><div><h1>Recruiter Company Link Requests</h1><p>Verify affiliation before linking a recruiter to an existing company.</p></div></div>
        <form id="developer-link-filters" class="panel" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">
          <input class="form-input" name="search" placeholder="Recruiter, email, or company" style="flex:1;min-width:220px;" value="${esc(filters.search||'')}">
          <select class="form-select" name="status"><option value="pending" ${(!filters.status||filters.status==='pending')?'selected':''}>Pending</option>${['approved','rejected','all'].map(s=>`<option value="${s}" ${filters.status===s?'selected':''}>${s==='all'?'All requests':s}</option>`).join('')}</select>
          <button class="btn btn-primary" type="submit">Filter requests</button>
        </form>
        ${requests.length ? `<div style="display:grid;gap:12px;">${requests.map(r=>`
          <div class="panel"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;"><div><h3 style="margin:0;">${esc(r.requested_full_name)} · @${esc(r.username)}</h3><p class="muted">${esc(r.requested_email||'No email')} · ${esc(r.requested_designation||'Recruiter')} · Requested ${formatDate(r.created_at)}</p></div><span class="status-pill ${esc(r.status)}">${esc(r.status)}</span></div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0;padding:12px;background:#f8fafd;border-radius:10px;"><div><b>Existing company</b><p>${esc(r.company_name)} · ${esc(r.company_status)}<br>${esc(r.company_industry||'')} · ${esc(r.company_location||'')}</p><span>${esc(r.company_website||'No website')}</span></div><div><b>Requested recruiter details</b><p>${esc(r.requested_full_name)}<br>${esc(r.requested_email||'No email')} · ${esc(r.requested_phone||'No phone')}<br>${esc(r.requested_designation||'Recruiter')}</p>${r.review_notes?`<small>Review note: ${esc(r.review_notes)}</small>`:''}</div></div>
            ${r.status==='pending'?`<div style="display:flex;justify-content:flex-end;gap:8px;"><button class="btn btn-danger" onclick="window.jobMatcher.reviewRecruiterLinkRequest(${r.request_id},'rejected')">Reject request</button><button class="btn btn-mint" ${r.company_status!=='approved'?'disabled title="Approve the company first"':''} onclick="window.jobMatcher.reviewRecruiterLinkRequest(${r.request_id},'approved')">Approve and link recruiter</button></div>`:`<small class="muted">Reviewed ${formatDate(r.reviewed_at)} by @${esc(r.reviewed_by||'unknown')}</small>`}
          </div>`).join('')}</div>` : `<div class="panel" style="text-align:center;padding:42px;"><h3>No ${esc(filters.status||'pending')} link requests</h3><p class="muted">Requests to join an existing company will appear here for administrator review.</p></div>`}
      `;
      $('#developer-link-filters').onsubmit=e=>{e.preventDefault();const fd=new FormData(e.currentTarget);renderDeveloperLinkRequests({search:fd.get('search'),status:fd.get('status')});};
      refreshIcons();
    } catch(e) { $("#main-content").innerHTML=`<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load link requests: ${esc(e.message)}</p></div>`; }
  }

  async function openDeveloperCompanyDetails(companyId) {
    try {
      const data = await api('/developer/companies');
      const company = (data.companies || []).find(item => item.id === companyId);
      if (!company) { toast('Company not found.', true); return; }
      $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal"><div class="modal-head"><div><h3>${esc(company.name)}</h3><span class="status-pill ${esc(company.status)}">${esc(company.status)}</span></div><button class="icon-btn" onclick="window.jobMatcher.closeModal()">×</button></div>
        <div class="modal-body"><p>${esc(company.description||'No company overview provided.')}</p><p><b>Industry:</b> ${esc(company.industry||'N/A')} · <b>Location:</b> ${esc(company.location||'N/A')}<br><b>Website:</b> ${esc(company.website||'N/A')}<br><b>Registered:</b> ${formatDate(company.created_at)} · <b>Jobs:</b> ${Number(company.jobs_count)||0}</p><p><b>Review:</b> ${esc(company.reviewer_username||'Not reviewed')} ${company.reviewed_at?`· ${formatDate(company.reviewed_at)}`:''}</p><h4>Linked recruiters</h4>${(company.recruiters||[]).map(r=>`<p>${esc(r.full_name)} · @${esc(r.username)} · ${esc(r.designation||'Recruiter')} · ${esc(r.email||'No email')}</p>`).join('')||'<p class="muted">No recruiters linked.</p>'}</div>
        ${company.status==='pending'?`<div class="modal-foot"><button class="btn btn-danger" onclick="window.jobMatcher.closeModal();window.jobMatcher.reviewCompany(${company.id},'rejected')">Reject company</button><button class="btn btn-mint" onclick="window.jobMatcher.closeModal();window.jobMatcher.reviewCompany(${company.id},'approved')">Approve company</button></div>`:''}
      </section></div>`;
      refreshIcons();
    } catch(e) { toast(e.message,true); }
  }

  async function openDeveloperJobDetails(jobId) {
    try {
      const data = await api(`/developer/jobs/${jobId}`);
      const job = data.job;
      if (!job) { toast('Opportunity not found.', true); return; }
      const skills = job.skills || [];
      $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal" style="max-width:860px"><div class="modal-head"><div><h3>${esc(job.title)}</h3><span class="status-pill ${esc(job.lifecycle_status||job.status)}">${esc(job.lifecycle_status||job.status)}</span></div><button class="icon-btn" onclick="window.jobMatcher.closeModal()">×</button></div>
        <div class="modal-body"><p><b>${esc(job.company_name||'Platform curated')}</b> · ${esc(job.company_status||'')} · ${esc(job.recruiter_name||'')}</p><p>${esc(job.opportunity_category||'Uncategorized')} · ${esc(job.opportunity_type||job.job_type||'')} · ${esc(job.work_mode||'Work mode not specified')} · ${esc(job.location||'Location unspecified')}</p><p><b>Owner:</b> ${esc(job.owner_type||'RECRUITER')} · <b>Source:</b> ${esc(opportunitySourceLabel(job))}</p><p><b>Deadline:</b> ${job.deadline?formatDate(job.deadline):'Not specified'} · <b>Applicants:</b> ${Number(job.applicant_count)||0}</p><p><b>Eligible branches:</b> ${esc((job.eligible_branches||[]).join(', ')||'All branches')}</p><p><b>Application mode:</b> ${esc(job.application_mode||'internal')} ${job.application_url?`· <a href="${esc(job.application_url)}" target="_blank" rel="noopener noreferrer">Application / registration link</a>`:''}</p><p><b>Official source:</b> ${job.source_url?`<a href="${esc(job.source_url)}" target="_blank" rel="noopener noreferrer">${esc(job.source_url)}</a>`:'Not provided'} · ${job.source_verified_at?`Source reviewed ${formatDate(job.source_verified_at)}`:''}</p><p><b>Compensation:</b> ${job.salary_min||job.salary_max?`${Number(job.salary_min)||0} – ${Number(job.salary_max)||0}`:'Not specified'}</p><h4>Description</h4><p style="white-space:pre-wrap">${esc(job.description||'No description provided.')}</p><h4>Skills</h4>${skills.length?`<div style="display:flex;gap:8px;flex-wrap:wrap">${skills.map(s=>`<span class="skill-chip">${esc(s.name)} · ${s.is_required?'Required':'Optional'}${s.min_proficiency?` · ${esc(s.min_proficiency)}`:''}</span>`).join('')}</div>`:'<p class="muted">No skills specified.</p>'}</div>
        ${job.owner_type==='ADMIN'?`<div class="modal-foot"><button class="btn btn-primary" onclick="window.jobMatcher.closeModal();window.jobMatcher.openDeveloperOpportunityForm(${job.id})">Edit curated opportunity</button></div>`:''}
      </section></div>`;
      refreshIcons();
    } catch(e) { toast(e.message,true); }
  }

  async function renderDeveloperUsersAudit(filters = {}) {
    try {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
      const data = await api(`/developer/users${query.toString() ? `?${query}` : ''}`);
      const users = data.users || [];

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>User Accounts Audit</h1>
            <p>Search platform accounts by username, name, email, or role. Credentials are never shown.</p>
          </div>
        </div>

        <form id="developer-user-filters" class="panel" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">
          <input class="form-input" name="search" maxlength="120" placeholder="Search username, name, or email" style="flex:1;min-width:220px;" value="${esc(filters.search || '')}">
          <select class="form-select" name="role" style="min-width:150px;">
            <option value="">All roles</option>${['user','recruiter','developer'].map(role => `<option value="${role}" ${filters.role===role?'selected':''}>${role==='user'?'candidate':role}</option>`).join('')}
          </select>
          <button type="submit" class="btn btn-primary">Filter accounts</button>
        </form>

        <div class="panel">
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Full Name</th>
                  <th>Email</th>
                  <th>Company</th>
                  <th>Registered At</th>
                </tr>
              </thead>
              <tbody>
                ${users.length ? users.map(u => `
                  <tr>
                    <td>#${u.account_id}</td>
                    <td><code>@${esc(u.username)}</code></td>
                    <td><span class="portal-card-badge ${u.role}">${esc(u.role)}</span></td>
                    <td><b>${esc(u.full_name || 'N/A')}</b></td>
                    <td>${esc(u.email || 'N/A')}</td>
                    <td>${u.company_name ? `${esc(u.company_name)} <span class="status-pill ${esc(u.company_status || '')}">${esc(u.company_status || '')}</span>` : '—'}</td>
                    <td>${formatDate(u.created_at)}</td>
                  </tr>
                `).join("") : '<tr><td colspan="7" class="muted" style="text-align:center;padding:28px;">No accounts match these filters.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      `;
      $('#developer-user-filters').onsubmit=e=>{e.preventDefault();const fd=new FormData(e.currentTarget);renderDeveloperUsersAudit({search:fd.get('search'),role:fd.get('role')});};
      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load users: ${esc(e.message)}</p></div>`;
    }
  }

  async function renderDeveloperJobsAudit(filters = {}) {
    try {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
      const data = await api(`/developer/jobs${query.toString() ? `?${query}` : ''}`);
      const jobs = data.jobs || [];

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>Job Openings Audit</h1>
            <p>Review opportunity lifecycle, ownership, required skills, and application counts across the platform.</p>
          </div>
        </div>

        <form id="developer-job-filters" class="panel" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">
          <input class="form-input" name="search" maxlength="120" placeholder="Search title, company, recruiter, or skill" style="flex:1;min-width:220px;" value="${esc(filters.search || '')}">
          <select class="form-select" name="status" style="min-width:150px;"><option value="">All lifecycle states</option>${['published','draft','closed','expired'].map(s=>`<option value="${s}" ${filters.status===s?'selected':''}>${s==='published'?'active':s}</option>`).join('')}</select>
          <input class="form-input" name="category" maxlength="100" placeholder="Category (optional)" style="min-width:170px;" value="${esc(filters.category||'')}">
          <select class="form-select" name="owner_type"><option value="">All owners</option><option value="ADMIN" ${filters.owner_type==='ADMIN'?'selected':''}>Platform curated</option><option value="RECRUITER" ${filters.owner_type==='RECRUITER'?'selected':''}>Recruiter</option></select>
          <select class="form-select" name="source_classification"><option value="">All source types</option>${[['ADMIN_CURATED_VERIFIED','Verified source'],['ADMIN_CURATED_PROGRAM','Official program'],['ADMIN_DEMO','Demo']].map(([v,l])=>`<option value="${v}" ${filters.source_classification===v?'selected':''}>${l}</option>`).join('')}</select>
          <button class="btn btn-primary" type="submit">Filter opportunities</button>
        </form>

        <div class="panel">
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Title</th>
                  <th>Company</th>
                  <th>Type / Mode</th>
                  <th>Applicants</th>
                  <th>Deadline</th>
                  <th>Status</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                ${jobs.length ? jobs.map(j => `
                  <tr>
                    <td>#${j.id}</td>
                    <td><b>${esc(j.title)}</b></td>
                    <td>${esc(j.company_name||'—')}</td>
                    <td><span class="status-pill ${j.owner_type==='ADMIN'?'approved':'pending'}">${j.owner_type==='ADMIN'?'Platform':'Recruiter'}</span><br><small class="muted">${esc(j.source_classification||'Company listing')}${j.is_verified?' · Verified':''}</small></td>
                    <td>${esc(j.opportunity_type||j.job_type||'Opportunity')} · ${esc(j.work_mode||'')}</td>
                    <td><b>${j.applicant_count}</b></td>
                    <td>${j.deadline ? formatDate(j.deadline) : 'Not specified'}</td>
                    <td><span class="status-pill ${j.lifecycle_status || j.status}">${esc(j.lifecycle_status || j.status)}</span></td>
                    <td><div class="admin-opportunity-actions"><button class="btn btn-outline btn-sm" onclick="window.jobMatcher.openDeveloperJobDetails(${j.id})">View</button>${j.owner_type==='ADMIN'?`<button class="btn btn-soft btn-sm" onclick="window.jobMatcher.openDeveloperOpportunityForm(${j.id})">Edit</button>${j.source_classification==='ADMIN_DEMO'?'':`<button class="btn btn-outline btn-sm" onclick="window.jobMatcher.setDeveloperOpportunityStatus(${j.id},'${j.status==='published'?'draft':'published'}')">${j.status==='published'?'Unpublish':'Publish'}</button>`}<button class="btn btn-danger btn-sm" onclick="window.jobMatcher.setDeveloperOpportunityStatus(${j.id},'closed')">Close</button>`:''}</div></td>
                  </tr>
                `).join("") : '<tr><td colspan="9" class="muted" style="text-align:center;padding:28px;">No opportunities match these filters.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      `;
      $('#developer-job-filters').onsubmit=e=>{e.preventDefault();const fd=new FormData(e.currentTarget);renderDeveloperJobsAudit({search:fd.get('search'),status:fd.get('status'),category:fd.get('category'),owner_type:fd.get('owner_type'),source_classification:fd.get('source_classification')});};
      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load jobs audit: ${esc(e.message)}</p></div>`;
    }
  }

  async function openDeveloperOpportunityForm(jobId = null) {
    editingAdminOpportunityId = jobId ? Number(jobId) : null;
    loadView("dev-opportunity-form");
  }

  async function setDeveloperOpportunityStatus(jobId, status) {
    if (status === "closed" && !window.confirm("Close this platform-curated opportunity?")) return;
    try {
      const result = await api(`/developer/jobs/${jobId}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      toast(result.message || `Opportunity set to ${status}.`);
      await renderDeveloperJobsAudit();
    } catch (error) { toast(error.message, true); }
  }

  async function renderDeveloperOpportunityForm() {
    const editingId = editingAdminOpportunityId;
    try {
      const [skillsData, detailData] = await Promise.all([
        api("/skills"),
        editingId ? api(`/developer/jobs/${editingId}`) : Promise.resolve({ job: null })
      ]);
      masterSkills = skillsData.skills || [];
      const job = detailData.job || {};
      if (editingId && job.owner_type !== "ADMIN") throw new Error("Only admin-curated opportunities can be managed here.");
      const selected = new Map((job.skills || []).map(skill => [Number(skill.id), skill]));
      const categories = [['job','Job'],['internship','Internship'],['hackathon','Hackathon'],['project','Project'],['open_source','Open source'],['research','Research'],['scholarship','Scholarship'],['fellowship','Fellowship'],['competition','Competition'],['workshop','Workshop'],['developer_program','Developer program'],['startup','Startup'],['apprenticeship','Apprenticeship'],['certification','Certification'],['government','Government'],['psu','PSU'],['gate','GATE'],['training','Training']];
      const types = [['employment','Employment'],['internship','Internship'],['hackathon','Hackathon'],['competition','Competition'],['scholarship','Scholarship'],['research','Research'],['fellowship','Fellowship'],['government','Government opportunity'],['psu','PSU recruitment'],['gate','GATE opportunity'],['workshop','Workshop'],['training','Training program'],['program','Official program'],['other','Other']];
      const branches = (job.eligible_branches || []).join(', ');
      $("#main-content").innerHTML = `
        <div class="page-heading"><div><h1>${editingId ? 'Edit curated opportunity' : 'Curate an opportunity'}</h1><p>Publish verified, source-linked listings through the existing administrator account.</p></div><button class="btn btn-outline" onclick="window.jobMatcher.loadView('dev-jobs')">Back to opportunities</button></div>
        <div class="panel admin-opportunity-form-panel"><form id="admin-opportunity-form" class="form-grid">
          <div class="form-field full"><label>Opportunity title</label><input class="form-input" name="title" maxlength="200" required value="${esc(job.title||'')}"></div>
          <div class="form-field"><label>Opportunity type</label><select class="form-select" name="opportunity_type" id="admin-opportunity-type">${types.map(([v,l])=>`<option value="${v}" ${job.opportunity_type===v?'selected':''}>${l}</option>`).join('')}</select></div>
          <div class="form-field" id="admin-job-type-field"><label>Employment type</label><select class="form-select" name="job_type"><option value="Full-time" ${job.job_type==='Full-time'?'selected':''}>Full-time</option><option value="Part-time" ${job.job_type==='Part-time'?'selected':''}>Part-time</option><option value="Contract" ${job.job_type==='Contract'?'selected':''}>Contract</option></select></div>
          <div class="form-field"><label>Category</label><select class="form-select" name="opportunity_category">${categories.map(([v,l])=>`<option value="${v}" ${(job.opportunity_category||'job')===v?'selected':''}>${l}</option>`).join('')}</select></div>
          <div class="form-field"><label>Organization / issuer (optional)</label><input class="form-input" name="organization_name" maxlength="200" value="${esc(job.organization_name||'')}"></div>
          <div class="form-field"><label>Work mode</label><select class="form-select" name="work_mode"><option value="" ${!job.work_mode?'selected':''}>Not specified by source</option>${['Remote','Hybrid','On-site'].map(v=>`<option ${job.work_mode===v?'selected':''}>${v}</option>`).join('')}</select></div>
          <div class="form-field"><label>Location (use Online for online events)</label><input class="form-input" name="location" maxlength="150" value="${esc(job.location||'Online')}" required></div>
          <fieldset class="form-field full" id="admin-hackathon-fields" style="border:1px solid #dce8e2;border-radius:12px;padding:14px;display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px"><legend>Hackathon event details</legend>
            <label>Organizer type<input class="form-input" name="organizer_type" maxlength="60" value="${esc(job.hackathon_details?.organizer_type||'')}"></label><label>Event mode<select class="form-select" name="event_mode"><option value="">Use opportunity mode</option>${['Online','Offline','Hybrid'].map(x=>`<option ${job.hackathon_details?.event_mode===x?'selected':''}>${x}</option>`).join('')}</select></label>
            <label>City<input class="form-input" name="city" maxlength="100" value="${esc(job.hackathon_details?.city||'')}"></label><label>State<input class="form-input" name="state" maxlength="100" value="${esc(job.hackathon_details?.state||'')}"></label><label>Country<input class="form-input" name="country" maxlength="100" value="${esc(job.hackathon_details?.country||'')}"></label>
            <label>Venue<input class="form-input" name="venue" maxlength="200" value="${esc(job.hackathon_details?.venue||'')}"></label>
            <label>Registration opens<input class="form-input" name="registration_open_date" type="date" value="${esc(job.hackathon_details?.registration_open_date||'')}"></label><label>Event starts<input class="form-input" name="event_start_date" type="date" value="${esc(job.hackathon_details?.event_start_date||job.start_date||'')}"></label><label>Event ends<input class="form-input" name="event_end_date" type="date" value="${esc(job.hackathon_details?.event_end_date||'')}"></label>
            <label>Minimum team size<input class="form-input" name="team_size_min" type="number" min="1" max="100" value="${esc(job.hackathon_details?.team_size_min||'')}"></label><label>Maximum team size<input class="form-input" name="team_size_max" type="number" min="1" max="100" value="${esc(job.hackathon_details?.team_size_max||'')}"></label>
            <label>Themes<input class="form-input" name="themes" maxlength="1000" value="${esc(job.hackathon_details?.themes||'')}" placeholder="AI/ML, Web, Cloud"></label><label>Tracks<input class="form-input" name="tracks" maxlength="2000" value="${esc(job.hackathon_details?.tracks||'')}"></label><label>Technologies<input class="form-input" name="technologies" maxlength="1000" value="${esc(job.hackathon_details?.technologies||'')}"></label>
            <label>Prize pool<input class="form-input" name="prize_pool" maxlength="100" value="${esc(job.hackathon_details?.prize_pool||'')}"></label><label>Prize details<input class="form-input" name="prize_details" maxlength="2000" value="${esc(job.hackathon_details?.prize_details||'')}"></label>
            <label>Banner image URL<input class="form-input" name="banner_url" type="url" value="${esc(job.hackathon_details?.banner_url||'')}"></label><label>Organizer logo URL<input class="form-input" name="organizer_logo_url" type="url" value="${esc(job.hackathon_details?.organizer_logo_url||'')}"></label><label>Organizer website<input class="form-input" name="organizer_website_url" type="url" value="${esc(job.hackathon_details?.organizer_website_url||'')}"></label>
            <label><input type="checkbox" name="individual_allowed" ${job.hackathon_details?.individual_allowed?'checked':''}> Individual participation allowed</label><label><input type="checkbox" name="certificates" ${job.hackathon_details?.certificates?'checked':''}> Certificates confirmed by source</label>
          </fieldset>
          <div class="form-field"><label>Application deadline</label><input class="form-input" name="deadline" type="date" value="${esc(job.deadline||'')}"><small class="muted">Enter only a deadline published by the official source. An external official listing may be left blank when no closing date is published.</small></div>
          <div class="form-field"><label>Source classification</label><select class="form-select" name="source_classification" id="admin-source-classification" required><option value="ADMIN_CURATED_VERIFIED" ${job.source_classification==='ADMIN_CURATED_VERIFIED'?'selected':''}>Verified official source</option><option value="ADMIN_CURATED_PROGRAM" ${job.source_classification==='ADMIN_CURATED_PROGRAM'?'selected':''}>Official program</option><option value="ADMIN_DEMO" ${job.source_classification==='ADMIN_DEMO'?'selected':''}>Demo sample (unpublished)</option></select></div>
          <div class="form-field full"><label>Official source URL</label><input class="form-input" name="source_url" type="url" maxlength="500" value="${esc(job.source_url||'')}" placeholder="https://official.example/opportunity"><small class="muted">Choose “Verified official source” only after checking the source and listing. Verification is recorded with your admin account and timestamp.</small></div>
          <div class="form-field"><label>Application handling</label><select class="form-select" name="application_mode" id="admin-application-mode"><option value="internal" ${job.application_mode!=='external'?'selected':''}>SkillBridge internal application</option><option value="external" ${job.application_mode==='external'?'selected':''}>Official external application / registration</option></select></div>
          <div class="form-field"><label>Official application / registration URL</label><input class="form-input" name="application_url" type="url" maxlength="500" value="${esc(job.application_url||'')}" placeholder="https://official.example/register"></div>
          <div class="form-field"><label>Compensation type</label><select class="form-select" name="paid_status">${[['paid','Paid'],['stipend','Stipend'],['prize','Prize'],['unpaid','Unpaid'],['none','Not specified']].map(([v,l])=>`<option value="${v}" ${(job.paid_status||'none')===v?'selected':''}>${l}</option>`).join('')}</select></div>
          <div class="form-field"><label>Minimum amount (optional)</label><input class="form-input" name="salary_min" type="number" min="0" step="0.01" value="${Number(job.salary_min)||0}"></div>
          <div class="form-field"><label>Maximum amount (optional)</label><input class="form-input" name="salary_max" type="number" min="0" step="0.01" value="${Number(job.salary_max)||0}"></div>
          <div class="form-field"><label>Experience / study level</label><select class="form-select" name="experience_level">${['Student','Fresher','Beginner','Intermediate','Advanced'].map(v=>`<option ${job.experience_level===v?'selected':''}>${v}</option>`).join('')}</select></div>
          <div class="form-field"><label>Positions (optional)</label><input class="form-input" name="positions" type="number" min="1" step="1" value="${esc(job.positions||'')}"></div>
          <div class="form-field full"><label>Eligible branches (comma-separated; leave blank for all)</label><input class="form-input" name="eligible_branches" value="${esc(branches)}" placeholder="CSE, ECE, EEE, Mechanical, Civil"></div>
          <div class="form-field full"><label>Description</label><textarea class="form-textarea" name="description" maxlength="50000" required>${esc(job.description||'')}</textarea></div>
          <div class="form-field full"><label>Requirements</label><textarea class="form-textarea" name="requirements" maxlength="50000">${esc(job.requirements||'')}</textarea></div>
          <div class="form-field full"><label>Eligibility details</label><textarea class="form-textarea" name="eligibility" maxlength="10000">${esc(job.eligibility||'')}</textarea></div>
          <div class="form-field full"><label>Skills (required skills receive higher matching weight)</label><input class="form-input" id="admin-skill-search" placeholder="Search skill catalog"><div class="admin-skill-list">${masterSkills.map(skill=>{const old=selected.get(Number(skill.id));return `<label class="admin-skill-row" data-admin-skill-row data-name="${esc(skill.name.toLowerCase())}"><span>${esc(skill.name)} <small class="muted">${esc(skill.category||'')}</small></span><select class="form-select" data-admin-skill-kind="${skill.id}"><option value="">Not selected</option><option value="required" ${old?.is_required?'selected':''}>Required</option><option value="optional" ${old&&!old.is_required?'selected':''}>Optional</option></select><select class="form-select" data-admin-skill-level="${skill.id}">${['Beginner','Intermediate','Advanced','Expert'].map(level=>`<option value="${level}" ${old?.min_proficiency===level?'selected':''}>${level}</option>`).join('')}</select></label>`}).join('')}</div></div>
          <div class="form-field"><label>Initial status</label><select class="form-select" name="status" id="admin-opportunity-status">${['draft','published','closed'].map(v=>`<option value="${v}" ${(job.status||'draft')===v?'selected':''}>${v==='published'?'Publish now':v}</option>`).join('')}</select></div>
          <div id="admin-opportunity-error" class="form-field full" role="alert" style="color:#b94d4d"></div>
          <div class="form-field full admin-form-actions"><button type="button" class="btn btn-outline" onclick="window.jobMatcher.loadView('dev-jobs')">Cancel</button><button type="submit" class="btn btn-primary">${editingId?'Save changes':'Create opportunity'}</button></div>
        </form></div>`;
      const typeSelect=$('#admin-opportunity-type');
      const updateType=()=>$('#admin-job-type-field').classList.toggle('hidden',!['employment','internship'].includes(typeSelect.value));
      typeSelect.addEventListener('change',updateType); updateType();
      const categorySelect=$('select[name="opportunity_category"]');
      const updateEventFields=()=>$('#admin-hackathon-fields').classList.toggle('hidden',categorySelect.value!=='hackathon'&&typeSelect.value!=='hackathon');
      categorySelect.addEventListener('change',updateEventFields); typeSelect.addEventListener('change',updateEventFields); updateEventFields();
      const sourceSelect=$('#admin-source-classification');const statusSelect=$('#admin-opportunity-status');
      const publishedOption=statusSelect.querySelector('option[value="published"]');
      const updateSourceRequirements=()=>{const demo=sourceSelect.value==='ADMIN_DEMO';const external=$('#admin-application-mode').value==='external';const officialExternal=external&&!demo;publishedOption.disabled=demo;if(demo&&statusSelect.value==='published')statusSelect.value='draft';$('input[name="source_url"]').required=!demo;$('input[name="application_url"]').required=external;$('input[name="deadline"]').required=!officialExternal;$('select[name="work_mode"]').required=!officialExternal;};
      sourceSelect.addEventListener('change',updateSourceRequirements);$('#admin-application-mode').addEventListener('change',updateSourceRequirements);updateSourceRequirements();
      $('#admin-skill-search').addEventListener('input',event=>{const q=event.target.value.trim().toLowerCase();$$('[data-admin-skill-row]').forEach(row=>row.classList.toggle('hidden',!row.dataset.name.includes(q)));});
      const today=new Date();
      const dateText=v=>`${v.getFullYear()}-${String(v.getMonth()+1).padStart(2,'0')}-${String(v.getDate()).padStart(2,'0')}`;
      const deadlineInput=$('input[name="deadline"]'); deadlineInput.min=dateText(today);
      $('#admin-opportunity-form').addEventListener('submit',async event=>{
        event.preventDefault();const form=event.currentTarget;const submit=form.querySelector('button[type="submit"]');const error=$('#admin-opportunity-error');error.textContent='';submit.disabled=true;submit.textContent='Saving…';
        const fd=new FormData(form);const skills=$$('[data-admin-skill-row]').flatMap(row=>{const kind=$('[data-admin-skill-kind]',row).value;return kind?[{skill_id:Number($('[data-admin-skill-kind]',row).dataset.adminSkillKind),is_required:kind==='required',min_proficiency:$('[data-admin-skill-level]',row).value}]:[];});
        const body={title:fd.get('title'),organization_name:fd.get('organization_name'),opportunity_type:fd.get('opportunity_type'),job_type:fd.get('job_type'),opportunity_category:fd.get('opportunity_category'),work_mode:fd.get('work_mode'),location:fd.get('location'),description:fd.get('description'),requirements:fd.get('requirements'),eligibility:fd.get('eligibility'),experience_level:fd.get('experience_level'),paid_status:fd.get('paid_status'),source_classification:fd.get('source_classification'),source_url:fd.get('source_url'),application_mode:fd.get('application_mode'),application_url:fd.get('application_url'),deadline:fd.get('deadline'),status:fd.get('status'),salary_min:fd.get('salary_min'),salary_max:fd.get('salary_max'),positions:fd.get('positions'),eligible_branches:fd.get('eligible_branches').split(',').map(v=>v.trim()).filter(Boolean),skill_ids:skills};
        body.hackathon_details={}; if(body.opportunity_category==='hackathon'||body.opportunity_type==='hackathon'){for(const key of ['organizer_type','event_mode','city','state','country','venue','themes','tracks','technologies','prize_pool','prize_details','banner_url','organizer_logo_url','organizer_website_url','registration_open_date','event_start_date','event_end_date','team_size_min','team_size_max'])body.hackathon_details[key]=fd.get(key)||'';body.hackathon_details.individual_allowed=fd.has('individual_allowed');body.hackathon_details.certificates=fd.has('certificates');}
        try{const path=editingId?`/developer/jobs/${editingId}`:'/developer/jobs';const result=await api(path,{method:editingId?'PUT':'POST',body:JSON.stringify(body)});toast(result.message||'Opportunity saved.');editingAdminOpportunityId=null;loadView('dev-jobs');}
        catch(err){error.textContent=err.message;submit.disabled=false;submit.textContent=editingId?'Save changes':'Create opportunity';}
      });
      refreshIcons();
    } catch(error){$('#main-content').innerHTML=`<div class="panel"><p class="muted" style="color:#c64c54">Failed to load opportunity editor: ${esc(error.message)}</p><button class="btn btn-outline" onclick="window.jobMatcher.loadView('dev-jobs')">Back</button></div>`;}
  }

  async function renderDeveloperApplicationsAudit(filters = {}) {
    try {
      const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
      const data = await api(`/developer/applications${query.toString() ? `?${query}` : ''}`);
      const apps = data.applications || [];

      $("#main-content").innerHTML = `
        <div class="page-heading">
          <div>
            <h1>Applications Audit Trail</h1>
            <p>Inspect application records and every recorded status transition across all companies.</p>
          </div>
        </div>

        <form id="developer-application-filters" class="panel" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;">
          <input class="form-input" name="search" maxlength="120" placeholder="Search candidate, email, opportunity, or company" style="flex:1;min-width:220px;" value="${esc(filters.search || '')}">
          <select class="form-select" name="status"><option value="">All statuses</option>${['submitted','under_review','shortlisted','interview','selected','rejected','withdrawn'].map(s=>`<option value="${s}" ${filters.status===s?'selected':''}>${applicationStatusLabel(s)}</option>`).join('')}</select>
          <button class="btn btn-primary" type="submit">Filter applications</button>
        </form>

        <div class="panel">
          <div class="table-wrap">
            <table class="data-table">
              <thead>
                <tr>
                  <th>App ID</th>
                  <th>Candidate</th>
                  <th>Position</th>
                  <th>Company</th>
                  <th>Current Status</th>
                  <th>Applied At</th>
                  <th>Status History</th>
                </tr>
              </thead>
              <tbody>
                ${apps.length ? apps.map(a => `
                  <tr>
                    <td>#${a.application_id}</td>
                    <td><b>${esc(a.candidate_name)}</b><br/><small class="muted">${esc(a.candidate_email || '')}</small></td>
                    <td>${esc(a.job_title)}</td>
                    <td>${esc(a.company_name)}</td>
                    <td><span class="status-pill ${esc(a.current_status)}">${applicationStatusLabel(a.current_status)}</span></td>
                    <td>${formatDate(a.applied_at)}</td>
                    <td>${(a.status_history||[]).length ? `<details><summary>${a.status_history.length} updates</summary><div style="min-width:220px;">${a.status_history.map(h=>`<p><b>${h.previous_status?`${applicationStatusLabel(h.previous_status)} → `:''}${applicationStatusLabel(h.status||'')}</b> · ${formatDate(h.changed_at)}<br><small>${esc(h.changed_by||'System')} ${h.notes?`· ${esc(h.notes)}`:''}</small></p>`).join('')}</div></details>` : '<span class="muted">No history</span>'}</td>
                  </tr>
                `).join("") : '<tr><td colspan="7" class="muted" style="text-align:center;padding:28px;">No applications match these filters.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      `;
      $('#developer-application-filters').onsubmit=e=>{e.preventDefault();const fd=new FormData(e.currentTarget);renderDeveloperApplicationsAudit({search:fd.get('search'),status:fd.get('status')});};
      refreshIcons();
    } catch (e) {
      $("#main-content").innerHTML = `<div class="panel"><p class="muted" style="color:#c64c54;">Failed to load applications: ${esc(e.message)}</p></div>`;
    }
  }

  // --------------------------------------------------------------------------
  // Modals & Interactive Actions
  // --------------------------------------------------------------------------
  function openAuthModal(role = "user", mode = "login") {
    const modalRoot = $("#modal-root");

    const roleTitles = {
      user: "Candidate / Job Seeker",
      recruiter: "Recruiter & Employer",
      developer: "Platform Administration"
    };

    modalRoot.innerHTML = `
      <div class="modal-backdrop" id="auth-modal-backdrop">
        <section class="modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title" aria-describedby="auth-modal-description">
          <div class="modal-head">
            <div>
              <h3 id="auth-modal-title">${roleTitles[role]}</h3>
              <p id="auth-modal-description" class="muted" style="font-size:11px;margin:2px 0 0;">
                ${role === 'developer' ? 'Authorized access for platform management.' : 'Sign in or create an account to continue.'}
              </p>
            </div>
            <button class="icon-btn" aria-label="Close sign in dialog" onclick="window.jobMatcher.closeModal()"><i data-lucide="x"></i></button>
          </div>

          <!-- Auth Mode Tabs (User & Recruiter have Sign In / Register; Developer has Sign In only) -->
          <div style="padding:16px 22px 0;">
            <div style="display:flex;gap:6px;background:#f0f3f8;padding:4px;border-radius:10px;">
              <button id="auth-tab-login" class="btn ${mode === 'login' ? 'btn-outline' : ''}" style="flex:1;font-size:11px;${mode === 'login' ? 'background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.06);' : 'background:transparent;border:0;color:#6b7c97;'}">
                Sign In
              </button>
              ${role !== 'developer' ? `
                <button id="auth-tab-register" class="btn ${mode === 'register' ? 'btn-outline' : ''}" style="flex:1;font-size:11px;${mode === 'register' ? 'background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.06);' : 'background:transparent;border:0;color:#6b7c97;'}">
                  ${role === 'recruiter' ? 'Register Company & Recruiter' : 'Create Candidate Account'}
                </button>
              ` : `
                <span style="font-size:10px;color:#9aa7bc;display:flex;align-items:center;padding:0 10px;">
                  <i data-lucide="lock" style="width:12px;margin-right:4px;"></i> Authorized accounts only
                </span>
              `}
            </div>
          </div>

          <div class="modal-body">
            <!-- 1. LOGIN FORM -->
            <form id="auth-login-form" class="${mode === 'login' ? '' : 'hidden'} form-grid">
              <input type="hidden" name="expected_role" value="${role}" />
              <div class="form-field full">
                <label for="auth-login-username">Username</label>
                <input id="auth-login-username" class="form-input" name="username" autocomplete="username" placeholder="Enter your username" required />
              </div>
              <div class="form-field full">
                <label for="auth-login-password">Password</label>
                <div class="password-field"><input id="auth-login-password" class="form-input" type="password" name="password" autocomplete="current-password" placeholder="Enter your password" required /><button class="password-toggle" type="button" data-password-toggle aria-label="Show password" aria-pressed="false"><i data-lucide="eye"></i></button></div>
              </div>
              <p id="auth-login-error" class="form-error" role="alert" aria-live="polite"></p>
              <div class="form-field full" style="margin-top:10px;">
                <button type="submit" class="btn btn-primary" style="width:100%;height:44px;">
                  Sign In <i data-lucide="arrow-right"></i>
                </button>
              </div>
            </form>

            <!-- 2. REGISTER CANDIDATE FORM -->
            ${role === 'user' ? `
              <form id="auth-reg-user-form" class="${mode === 'register' ? '' : 'hidden'} form-grid">
                <div class="form-field full">
                  <label>Full Name</label>
                  <input class="form-input" name="name" placeholder="e.g. John Doe" required />
                </div>
                <div class="form-field">
                  <label>Choose Username</label>
                  <input class="form-input" name="username" placeholder="e.g. john_dev" required />
                </div>
                <div class="form-field">
                  <label for="auth-user-password">Password</label>
                  <div class="password-field"><input id="auth-user-password" class="form-input" type="password" name="password" autocomplete="new-password" placeholder="At least 6 characters" required /><button class="password-toggle" type="button" data-password-toggle aria-label="Show password" aria-pressed="false"><i data-lucide="eye"></i></button></div>
                </div>
                <div class="form-field">
                  <label>Email Address (Optional)</label>
                  <input class="form-input" type="email" name="email" placeholder="john@example.com" />
                </div>
                <div class="form-field">
                  <label>Phone Number (Optional)</label>
                  <input class="form-input" name="phone" placeholder="+91 ..." />
                </div>
                <div class="form-field full">
                  <label>Professional Headline</label>
                  <input class="form-input" name="headline" placeholder="e.g. React & Python Developer" />
                </div>
                <p id="auth-reg-error" class="form-error" role="alert" aria-live="polite"></p>
                <div class="form-field full" style="margin-top:10px;">
                  <button type="submit" class="btn btn-primary" style="width:100%;height:44px;">
                    Create Candidate Account <i data-lucide="check"></i>
                  </button>
                </div>
              </form>
            ` : ''}

            <!-- 3. REGISTER RECRUITER FORM -->
            ${role === 'recruiter' ? `
              <form id="auth-reg-rec-form" class="${mode === 'register' ? '' : 'hidden'} form-grid">
                <div class="form-field full">
                  <label>Company / Organization Name</label>
                  <input class="form-input" name="company_name" placeholder="e.g. TechCorp Solutions" required />
                </div>
                <div class="form-field">
                  <label>Recruiter Full Name</label>
                  <input class="form-input" name="recruiter_name" placeholder="e.g. Sarah Connor" required />
                </div>
                <div class="form-field">
                  <label>Designation</label>
                  <input class="form-input" name="designation" placeholder="e.g. Talent Acquisition Lead" />
                </div>
                <div class="form-field">
                  <label>Choose Username</label>
                  <input class="form-input" name="username" placeholder="e.g. sarah_techcorp" required />
                </div>
                <div class="form-field">
                  <label for="auth-recruiter-password">Password</label>
                  <div class="password-field"><input id="auth-recruiter-password" class="form-input" type="password" name="password" autocomplete="new-password" placeholder="At least 6 characters" required /><button class="password-toggle" type="button" data-password-toggle aria-label="Show password" aria-pressed="false"><i data-lucide="eye"></i></button></div>
                </div>
                <div class="form-field">
                  <label>Company Website</label>
                  <input class="form-input" name="website" placeholder="https://techcorp.com" />
                </div>
                <div class="form-field">
                  <label>Industry</label>
                  <input class="form-input" name="industry" placeholder="e.g. Software & Cloud" />
                </div>
                <div class="form-field full">
                  <label>Company Headquarters / Location</label>
                  <input class="form-input" name="location" placeholder="e.g. Bengaluru, India" />
                </div>
                <div class="form-field full">
                  <label>Company Description</label>
                  <textarea class="form-textarea" name="company_description" placeholder="Brief overview of company mission and products..."></textarea>
                </div>
                <div style="background:#fff9eb;border:1px solid #fae2af;border-radius:9px;padding:10px;font-size:11px;color:#8f6016;grid-column:1/-1;">
                  <i data-lucide="info" style="width:14px;display:inline;"></i> <b>Organization review:</b> Your organization will be reviewed before recruiter access is enabled.
                </div>
                <p id="auth-reg-error" class="form-error" role="alert" aria-live="polite"></p>
                <div class="form-field full" style="margin-top:10px;">
                  <button type="submit" class="btn btn-mint" style="width:100%;height:44px;">
                    Register Recruiter & Company <i data-lucide="arrow-right"></i>
                  </button>
                </div>
              </form>
            ` : ''}
          </div>
        </section>
      </div>
    `;

    refreshIcons();
    associateFieldLabels(modalRoot);

    $$('[data-password-toggle]', modalRoot).forEach(toggle => {
      toggle.addEventListener('click', () => {
        const input = toggle.parentElement.querySelector('input');
        const visible = input.type === 'password';
        input.type = visible ? 'text' : 'password';
        toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
        toggle.setAttribute('aria-pressed', String(visible));
        toggle.innerHTML = '<i data-lucide="' + (visible ? 'eye-off' : 'eye') + '"></i>';
        refreshIcons();
      });
    });

    // Setup tab listeners
    const tabLogin = $("#auth-tab-login");
    const tabReg = $("#auth-tab-register");
    if (tabReg) {
      tabLogin.onclick = () => {
        $("#auth-login-form").classList.remove("hidden");
        if ($("#auth-reg-user-form")) $("#auth-reg-user-form").classList.add("hidden");
        if ($("#auth-reg-rec-form")) $("#auth-reg-rec-form").classList.add("hidden");
        tabLogin.style.background = "#fff";
        tabReg.style.background = "transparent";
      };
      tabReg.onclick = () => {
        $("#auth-login-form").classList.add("hidden");
        if ($("#auth-reg-user-form")) $("#auth-reg-user-form").classList.remove("hidden");
        if ($("#auth-reg-rec-form")) $("#auth-reg-rec-form").classList.remove("hidden");
        tabReg.style.background = "#fff";
        tabLogin.style.background = "transparent";
      };
    }

    // Login Form Submit
    $("#auth-login-form").onsubmit = async e => {
      e.preventDefault();
      if (e.currentTarget.getAttribute('aria-busy') === 'true') return;
      const errBox = $("#auth-login-error");
      errBox.textContent = "";
      const fd = new FormData(e.target);
      const body = Object.fromEntries(fd.entries());

      setFormBusy(e.currentTarget, true);
      try {
        const res = await api("/auth/login", { method: "POST", body: JSON.stringify(body) });
        closeModal();
        toast(res.message);
        setSession(res.user);
      } catch (err) {
        errBox.textContent = err.message;
      } finally {
        setFormBusy(e.currentTarget, false);
      }
    };

    // Candidate Register Form Submit
    if ($("#auth-reg-user-form")) {
      $("#auth-reg-user-form").onsubmit = async e => {
        e.preventDefault();
        if (e.currentTarget.getAttribute('aria-busy') === 'true') return;
        const errBox = $("#auth-reg-error");
        errBox.textContent = "";
        const fd = new FormData(e.target);
        const body = Object.fromEntries(fd.entries());

        setFormBusy(e.currentTarget, true);
        try {
          const res = await api("/auth/register/user", { method: "POST", body: JSON.stringify(body) });
          closeModal();
          toast(res.message);
          setSession(res.user);
        } catch (err) {
          errBox.textContent = err.message;
        } finally {
          setFormBusy(e.currentTarget, false);
        }
      };
    }

    // Recruiter Register Form Submit
    if ($("#auth-reg-rec-form")) {
      $("#auth-reg-rec-form").onsubmit = async e => {
        e.preventDefault();
        if (e.currentTarget.getAttribute('aria-busy') === 'true') return;
        const errBox = $("#auth-reg-error");
        errBox.textContent = "";
        const fd = new FormData(e.target);
        const body = Object.fromEntries(fd.entries());

        setFormBusy(e.currentTarget, true);
        try {
          const res = await api("/auth/register/recruiter", { method: "POST", body: JSON.stringify(body) });
          closeModal();
          toast(res.message);
        } catch (err) {
          errBox.textContent = err.message;
        } finally {
          setFormBusy(e.currentTarget, false);
        }
      };
    }
  }

  function closeModal() {
    $("#modal-root").innerHTML = "";
  }

  // --------------------------------------------------------------------------
  // Candidate Application Modal
  // --------------------------------------------------------------------------
  async function openJobDetails(jobId) {
    try {
      const { job } = await api(`/jobs/${jobId}`);
      if (job.opportunity_category === 'hackathon') return openHackathonDetails(job);
      const skills = job.required_skills || [];
      $("#modal-root").innerHTML = `
        <div class="modal-backdrop"><div class="modal">
          <div class="modal-head"><div><h3>${esc(job.title)}</h3><p class="muted">${esc(job.company_name)} · ${esc(job.work_mode||'Work mode not specified')} · ${esc(job.location)}</p></div><button class="icon-btn" onclick="window.jobMatcher.closeModal()"><i data-lucide="x"></i></button></div>
          <div class="modal-body" style="display:grid;gap:14px;">
            <div>${renderSourceBadge(job)}</div>
            <div class="job-meta-row"><span>${esc(opportunityDeadlineLabel(job))}</span>${opportunityCompensationLabel(job)?`<span>${esc(opportunityCompensationLabel(job))}</span>`:''}<span>${esc(job.opportunity_type||job.job_type||'Opportunity')}</span><span>${esc(job.work_mode||'Work mode not specified')} · ${esc(job.location||'Location not specified')}</span></div>
            <div><b>Description</b><p class="muted">${esc(job.description || 'No description provided.')}</p></div>
            <div><b>Requirements</b><p class="muted">${esc(job.requirements || 'No additional requirements provided.')}</p></div>
            <div><b>Branch eligibility</b><p class="muted">${esc(opportunityBranchLabel(job))}</p></div>
            <div><b>Eligibility</b><p class="muted">${esc(job.eligibility || 'Review the official opportunity page for role-specific criteria.')}</p></div>
            ${job.source_url?`<div><b>Official source</b><p><a href="${esc(job.source_url)}" target="_blank" rel="noopener noreferrer">Open source listing <i data-lucide="external-link"></i></a> ${job.source_verified_at?`<small class="muted">Source reviewed ${formatDate(job.source_verified_at)}</small>`:''}</p></div>`:''}
            <div><b>Skills and minimum proficiency</b><div class="skill-chips">${skills.length ? skills.map(s => `<span class="skill-chip">${esc(s.name)} · ${esc(s.min_proficiency || 'Intermediate')}${s.is_required ? ' · Required' : ' · Optional'}</span>`).join('') : '<span class="muted">No specific skills listed by the source.</span>'}</div></div>
            ${renderSkillGapHTML(job)}
            <div style="display:flex;justify-content:flex-end;gap:8px;">${renderSaveButton(job.id)}${renderApplicationAction(job, 'Apply')}</div>
          </div>
        </div></div>`;
      refreshIcons();
    } catch (err) { toast(err.message, true); }
  }

  function openHackathonDetails(event) {
    const d=event.hackathon_details||{};
    const line=(label,value)=>value?`<div><b>${label}</b><p class="muted">${esc(value)}</p></div>`:'';
    const dates=[d.event_start_date||event.start_date,d.event_end_date].filter(Boolean).map(formatDate).join(' – ');
    const venue=[d.venue,d.city,d.state,d.country].filter(Boolean).join(', ');
    const tags=[d.themes,d.tracks,d.technologies].filter(Boolean).join(' · ');
    const team=d.team_size_min||d.team_size_max?`${d.team_size_min||1}–${d.team_size_max||d.team_size_min} participants`:'';
    $('#modal-root').innerHTML=`<div class="modal-backdrop"><div class="modal"><div class="modal-head"><div><h3>${esc(event.title)}</h3><p class="muted">${esc(event.organization_name||'')} · ${esc(d.event_mode||event.work_mode||'')}</p></div><button class="icon-btn" onclick="window.jobMatcher.closeModal()"><i data-lucide="x"></i></button></div><div class="modal-body" style="display:grid;gap:12px">${d.banner_url?`<img src="${esc(d.banner_url)}" alt="Hackathon banner" style="width:100%;max-height:220px;object-fit:cover;border-radius:12px">`:''}${event.is_verified?'<span class="hackathon-verified">Verified source</span>':''}${line('Organizer type',d.organizer_type)}${line('About the event',event.description)}${line('Event dates',dates)}${line('Registration deadline',event.deadline?formatDate(event.deadline):'')}${line('Location',venue||event.location)}${line('Themes and tracks',tags)}${line('Team size',team)}${d.individual_allowed?'<div>Individual participation allowed</div>':''}${line('Eligibility',event.eligibility)}${line('Prize pool',d.prize_pool)}${line('Prize details',d.prize_details)}${line('Certificates',d.certificates?'Confirmed by source':'')}${event.source_url?`<a href="${esc(event.source_url)}" target="_blank" rel="noopener noreferrer">Official event source</a>`:''}${d.organizer_website_url?`<a href="${esc(d.organizer_website_url)}" target="_blank" rel="noopener noreferrer">Organizer website</a>`:''}<div class="hackathon-actions">${renderSaveButton(event.id)}${renderApplicationAction({...event,application_mode:'external'},'Register Now')}</div></div></div></div>`;
    refreshIcons();
  }

  async function openApplyModal(jobId, jobTitle) {
    try {
      if (!jobTitle) {
        const { job } = await api(`/jobs/${jobId}`);
        jobTitle = job.title;
      }
      const data = await api("/candidate/profile");
      const resumes = data.resumes || [];

      $("#modal-root").innerHTML = `
        <div class="modal-backdrop">
          <div class="modal">
            <div class="modal-head">
              <div>
                <h3>Apply for Job Opening</h3>
                <p class="muted" style="font-size:11px;">Submitting application for <b>${esc(jobTitle)}</b></p>
              </div>
              <button class="icon-btn" onclick="window.jobMatcher.closeModal()"><i data-lucide="x"></i></button>
            </div>
            <form id="submit-application-form" class="modal-body form-grid">
              <div class="form-field full">
                <label>Select CV / Resume to Submit</label>
                ${resumes.length === 0 ? `
                  <div style="background:#fff2f2;border:1px solid #ffd6d6;border-radius:9px;padding:10px;font-size:11px;color:#c04d55;">
                    <i data-lucide="alert-circle" style="width:14px;display:inline;"></i> You don't have any uploaded CVs yet. Please upload one in your Profile before applying, or submit without CV.
                  </div>
                ` : `
                  <select class="form-select" name="resume_id">
                    ${resumes.map(r => `
                      <option value="${r.id}" ${r.is_default ? 'selected' : ''}>
                        ${esc(r.file_name)} ${r.is_default ? '(Default)' : ''}
                      </option>
                    `).join("")}
                  </select>
                `}
              </div>

              <div class="form-field full">
                <label>Cover Letter / Note for Recruiter (Optional)</label>
                <textarea class="form-textarea" name="cover_letter" placeholder="Why are you a good fit for this role? Mention your matching skills..."></textarea>
              </div>

              <p id="apply-error" style="color:#c64c54;font-size:11px;grid-column:1/-1;margin:0;"></p>

              <div class="form-field full" style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">
                <button type="button" class="btn btn-outline" onclick="window.jobMatcher.closeModal()">Cancel</button>
                <button type="submit" class="btn btn-primary"><i data-lucide="send"></i> Confirm & Submit</button>
              </div>
            </form>
          </div>
        </div>
      `;

      refreshIcons();

      $("#submit-application-form").onsubmit = async e => {
        e.preventDefault();
        const fd = new FormData(e.target);
        const resumeId = fd.get("resume_id");
        const coverLetter = fd.get("cover_letter");
        const errBox = $("#apply-error");
        errBox.textContent = "";

        try {
          const res = await api(`/jobs/${jobId}/apply`, {
            method: "POST",
            body: JSON.stringify({
              resume_id: resumeId ? Number(resumeId) : null,
              cover_letter: coverLetter
            })
          });
          closeModal();
          toast(res.message);
          refreshNotificationUnreadCount();
          loadView("applications");
        } catch (err) {
          errBox.textContent = err.message;
        }
      };
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function withdrawApplication(applicationId) {
    if (!Number.isInteger(Number(applicationId)) || Number(applicationId) < 1) return;
    if (!confirm("Withdraw this application? This action cannot be reversed.")) return;
    try {
      const result = await api(`/candidate/applications/${Number(applicationId)}/withdraw`, { method: "POST", body: JSON.stringify({}) });
      toast(result.message || "Application withdrawn.");
      await renderCandidateApplications();
    } catch (error) {
      toast(error.message || "Unable to withdraw this application.", true);
    }
  }

  // --------------------------------------------------------------------------
  // Recruiter Status Modal
  // --------------------------------------------------------------------------
  function openStatusModal(appId, currentStatus) {
    const allowedNext = nextRecruiterStatuses(currentStatus);
    $("#modal-root").innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" style="max-width:480px;">
          <div class="modal-head">
            <h3>Update Application Status</h3>
            <button class="icon-btn" onclick="window.jobMatcher.closeModal()"><i data-lucide="x"></i></button>
          </div>
          <form id="update-status-form" class="modal-body form-grid">
            <div class="form-field full">
              <label>Select New Stage</label>
              ${allowedNext.length ? `<select class="form-select" name="status">${allowedNext.map(status=>`<option value="${status}">${applicationStatusLabel(status)}</option>`).join('')}</select>` : `<p class="muted">This application is ${applicationStatusLabel(currentStatus)}; no further status transition is available.</p>`}
            </div>
            <div class="form-field full">
              <label>Recruiter Feedback Note (Recorded in Audit History)</label>
              <textarea class="form-textarea" name="notes" placeholder="e.g. Strong relational database skills. Shortlisted for technical round."></textarea>
            </div>
            <div class="form-field full" style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px;">
              <button type="button" class="btn btn-outline" onclick="window.jobMatcher.closeModal()">Cancel</button>
              <button type="submit" class="btn btn-primary" ${allowedNext.length ? '' : 'disabled'}>Save Status</button>
            </div>
          </form>
        </div>
      </div>
    `;

    refreshIcons();

    $("#update-status-form").onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const status = fd.get("status");
      const notes = fd.get("notes");
      const submit = e.submitter;
      if (!status) return;
      if (submit) { submit.disabled = true; submit.textContent = "Saving…"; }

      try {
        const res = await api(`/recruiter/applications/${appId}/status`, {
          method: "PUT",
          body: JSON.stringify({ status, notes })
        });
        closeModal();
        toast(res.message);
        loadView("recruiter-applicants");
      } catch (err) {
        toast(err.message, true);
        if (submit) { submit.disabled = false; submit.textContent = "Save Status"; }
      }
    };
  }

  // --------------------------------------------------------------------------
  // Developer Actions
  // --------------------------------------------------------------------------
  async function reviewCompany(companyId, status) {
    const action = status === "approved" ? "approve" : "reject";
    if (!confirm(`Are you sure you want to ${action} this company registration?`)) return;

    try {
      const res = await api(`/developer/companies/${companyId}/review`, {
        method: "POST",
        body: JSON.stringify({ status })
      });
      toast(res.message);
      loadView(currentView);
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function reviewRecruiterLinkRequest(requestId, status) {
    const action = status === 'approved' ? 'link this recruiter to the company' : 'reject this recruiter link request';
    if (!confirm(`Are you sure you want to ${action}?`)) return;
    const notes = prompt('Optional review note for the audit record:', '') || '';
    try {
      const result = await api(`/developer/companies/link-requests/${requestId}/review`, {method:'POST',body:JSON.stringify({status,notes})});
      toast(result.message);
      loadView(currentView);
    } catch(err) { toast(err.message,true); }
  }

  async function toggleJobStatus(jobId, newStatus) {
    try {
      const res = await api(`/recruiter/jobs/${jobId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus })
      });
      toast(res.message);
      loadView("recruiter-jobs");
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function renewJob(jobId) {
    const deadline = prompt("Enter the new application deadline (YYYY-MM-DD). This will republish the expired opportunity.");
    if (!deadline) return;
    try {
      const result = await api(`/recruiter/jobs/${jobId}/renew`, { method: "POST", body: JSON.stringify({ deadline }) });
      toast(result.message);
      loadView("recruiter-jobs");
    } catch (err) { toast(err.message, true); }
  }

  async function editJob(jobId) {
    try {
      const data = await api('/recruiter/jobs');
      const j = (data.jobs || []).find(x => x.id === jobId);
      if (!j) return;
      const catalog = await api('/skills');
      const current = new Map((j.skills || []).map(x => [Number(x.id), x]));
      const skills = (catalog.skills || []).map(s => {
        const old = current.get(Number(s.id));
        return `<label data-edit-skill-row data-name="${esc(s.name.toLowerCase())}" style="display:grid;grid-template-columns:minmax(150px,1fr) 130px 150px;align-items:center;gap:8px;padding:6px;border-bottom:1px solid #edf0f5"><span>${esc(s.name)} <small class="muted">${esc(s.category || '')}</small></span><select class="form-select" data-edit-kind="${s.id}"><option value="">Not selected</option><option value="required" ${old?.is_required === true ? 'selected' : ''}>Required</option><option value="optional" ${old && old.is_required === false ? 'selected' : ''}>Optional</option></select><select class="form-select" data-edit-level="${s.id}">${['Beginner','Intermediate','Advanced','Expert'].map(level => `<option value="${level}" ${(old?.min_proficiency || 'Intermediate') === level ? 'selected' : ''}>Min ${level}</option>`).join('')}</select></label>`;
      }).join('');
      const categoryOptions = [['job','Job'],['internship','Internship'],['hackathon','Hackathon'],['project','Project'],['open_source','Open source'],['research','Research'],['scholarship','Scholarship'],['fellowship','Fellowship'],['competition','Competition'],['workshop','Workshop'],['developer_program','Developer program'],['startup','Startup'],['apprenticeship','Apprenticeship'],['certification','Certification']];
      const expired = j.lifecycle_status === 'expired';
      $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal" style="max-width:860px"><div class="modal-head"><h3>Edit opportunity</h3><button type="button" class="icon-btn" onclick="window.jobMatcher.closeModal()">×</button></div><form id="edit-opportunity-form" class="modal-body form-grid">
        <div class="form-field full"><label>Title</label><input class="form-input" name="title" maxlength="200" required value="${esc(j.title)}"></div>
        <div class="form-field"><label>Opportunity type</label><select class="form-select" name="job_type">${['Full-time','Part-time','Internship','Contract'].map(v=>`<option ${j.job_type===v?'selected':''}>${v}</option>`).join('')}</select></div>
        <div class="form-field"><label>Category</label><select class="form-select" name="opportunity_category">${categoryOptions.map(([v,label])=>`<option value="${v}" ${j.opportunity_category===v?'selected':''}>${label}</option>`).join('')}</select></div>
        <div class="form-field"><label>Work mode</label><select class="form-select" name="work_mode">${['Remote','Hybrid','On-site'].map(v=>`<option ${j.work_mode===v?'selected':''}>${v}</option>`).join('')}</select></div>
        <div class="form-field"><label>Location</label><input class="form-input" name="location" maxlength="150" required value="${esc(j.location)}"></div>
        <div class="form-field"><label>Application deadline${expired?' (renew separately)':''}</label><input class="form-input" name="deadline" type="date" ${expired?'disabled':''} value="${esc(String(j.deadline).slice(0,10))}" ${!expired?`min="${new Date().toISOString().slice(0,10)}"`:''}></div>
        <div class="form-field"><label>Experience level</label><select class="form-select" name="experience_level">${['Student','Fresher','Beginner','Intermediate','Advanced'].map(v=>`<option ${j.experience_level===v?'selected':''}>${v}</option>`).join('')}</select></div>
        <div class="form-field"><label>Minimum compensation</label><input class="form-input" name="salary_min" type="number" min="0" step="0.01" value="${Number(j.salary_min)||0}"></div>
        <div class="form-field"><label>Maximum compensation</label><input class="form-input" name="salary_max" type="number" min="0" step="0.01" value="${Number(j.salary_max)||0}"></div>
        <div class="form-field"><label>Compensation type</label><select class="form-select" name="paid_status">${['paid','stipend','unpaid','prize','none'].map(v=>`<option value="${v}" ${j.paid_status===v?'selected':''}>${v}</option>`).join('')}</select></div>
        <div class="form-field"><label>Positions</label><input class="form-input" name="positions" type="number" min="1" step="1" value="${j.positions||''}"></div>
        <div class="form-field"><label>Start date</label><input class="form-input" name="start_date" type="date" value="${j.start_date?String(j.start_date).slice(0,10):''}"></div>
        <div class="form-field"><label>Duration</label><input class="form-input" name="duration" maxlength="100" value="${esc(j.duration||'')}"></div>
        <div class="form-field full"><label>Description</label><textarea class="form-textarea" name="description" required>${esc(j.description)}</textarea></div>
        <div class="form-field full"><label>Requirements</label><textarea class="form-textarea" name="requirements">${esc(j.requirements||'')}</textarea></div>
        <div class="form-field full"><label>Eligibility</label><textarea class="form-textarea" name="eligibility">${esc(j.eligibility||'')}</textarea></div>
        <div class="form-field full"><label>External application URL</label><input class="form-input" name="application_url" type="url" value="${esc(j.application_url||'')}"></div>
        <div class="form-field full"><label>Required and optional skills</label><input id="edit-skill-search" class="form-input" placeholder="Search skills"><div style="max-height:220px;overflow:auto;margin-top:8px">${skills||'<p class="muted">No catalog skills available.</p>'}</div></div>
        ${expired?'<p class="muted full">This deadline has passed. Save other edits here, then use “Renew with new deadline” to republish.</p>':''}
        <p id="edit-opportunity-error" class="full" style="color:#c64c54"></p><div class="full" style="display:flex;justify-content:flex-end;gap:8px"><button type="button" class="btn btn-outline" onclick="window.jobMatcher.closeModal()">Cancel</button><button type="submit" class="btn btn-primary">Save opportunity</button></div>
      </form></section></div>`;
      $('#edit-skill-search').oninput = e => $$('[data-edit-skill-row]').forEach(row => row.classList.toggle('hidden', !row.dataset.name.includes(e.target.value.trim().toLowerCase())));
      $('#edit-opportunity-form').onsubmit = async e => {
        e.preventDefault();
        const form = e.currentTarget, fd = new FormData(form), btn = e.submitter;
        const body = Object.fromEntries(fd.entries());
        for (const key of ['salary_min','salary_max','positions']) body[key] = body[key] === '' ? null : Number(body[key]);
        if (!body.deadline) delete body.deadline;
        if (!body.start_date) body.start_date = null;
        body.skill_ids = $$('[data-edit-skill-row]').flatMap(row => {
          const kind = $('[data-edit-kind]', row).value;
          return kind ? [{skill_id:Number($('[data-edit-kind]', row).dataset.editKind),is_required:kind==='required',min_proficiency:$('[data-edit-level]', row).value}] : [];
        });
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        try { const result = await api(`/recruiter/jobs/${jobId}`, {method:'PUT',body:JSON.stringify(body)}); toast(result.message || 'Opportunity updated.'); closeModal(); loadView('recruiter-jobs'); }
        catch (err) { $('#edit-opportunity-error').textContent = err.message; if (btn) { btn.disabled=false; btn.textContent='Save opportunity'; } }
      };
      refreshIcons();
    } catch(err){toast(err.message,true)}
  }

  async function deleteSkill(skillId) {
    if (!confirm("Remove this skill from your profile?")) return;
    try {
      await api(`/candidate/skills/${skillId}`, { method: "DELETE" });
      toast("Skill removed.");
      renderCandidateProfile();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function editSkill(skillId) {
    const profileData = await api('/candidate/profile');
    const skill = (profileData.skills || []).find(item => item.skill_id === skillId);
    if (!skill) { toast('Skill not found. Refresh your profile and try again.', true); return; }
    const { skill_name: skillName, proficiency, years_of_experience: years } = skill;
    const level = prompt(`Proficiency for ${skillName} (Beginner, Intermediate, Advanced, Expert)`, proficiency);
    if (!level) return;
    const experience = prompt("Years of experience with this skill", years);
    if (experience === null) return;
    try { await api('/candidate/skills',{method:'POST',body:JSON.stringify({skill_id:skillId,proficiency:level,years_of_experience:experience})}); toast('Skill updated.'); renderCandidateProfile(); }
    catch(err){toast(err.message,true)}
  }

  async function deleteAchievement(id) {
    if(!confirm('Delete this achievement?'))return;
    try{await api(`/candidate/achievements/${id}`,{method:'DELETE'});toast('Achievement deleted.');renderCandidateProfile()}catch(err){toast(err.message,true)}
  }

  async function editAchievement(id) {
    const data=await api('/candidate/profile'); const item=(data.achievements||[]).find(x=>x.id===id); if(!item)return;
    const title=prompt('Achievement title',item.title); if(title===null)return;
    const issuer=prompt('Issuer',item.issuer||''); if(issuer===null)return;
    const description=prompt('Description',item.description||''); if(description===null)return;
    try{await api(`/candidate/achievements/${id}`,{method:'PUT',body:JSON.stringify({...item,title,issuer,description})});toast('Achievement updated.');renderCandidateProfile()}catch(err){toast(err.message,true)}
  }

  async function editEducation(id) {
    const data=await api('/candidate/profile'); const item=(data.education||[]).find(x=>x.id===id); if(!item)return;
    const institution=prompt('College / university',item.institution); if(institution===null)return;
    const degree=prompt('Degree / course',item.degree); if(degree===null)return;
    const field_of_study=prompt('Branch / department',item.field_of_study||''); if(field_of_study===null)return;
    try{await api(`/candidate/education/${id}`,{method:'PUT',body:JSON.stringify({...item,institution,degree,field_of_study})});toast('Education updated.');renderCandidateProfile()}catch(err){toast(err.message,true)}
  }

  async function editExperience(id) {
    const data=await api('/candidate/profile'); const item=(data.experience||[]).find(x=>x.id===id); if(!item)return;
    const role_title=prompt('Role / position',item.role_title); if(role_title===null)return;
    const company_name=prompt('Organization',item.company_name); if(company_name===null)return;
    const description=prompt('Description',item.description||''); if(description===null)return;
    try{await api(`/candidate/experience/${id}`,{method:'PUT',body:JSON.stringify({...item,role_title,company_name,description})});toast('Experience updated.');renderCandidateProfile()}catch(err){toast(err.message,true)}
  }

  async function deleteResume(resumeId) {
    if (!confirm("Delete this resume file?")) return;
    try {
      await api(`/candidate/resumes/${resumeId}`, { method: "DELETE" });
      toast("Resume removed.");
      renderCandidateProfile();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function setDefaultResume(resumeId) {
    try {
      await api(`/candidate/resumes/${resumeId}/default`, { method: "PUT" });
      toast("Default resume updated.");
      renderCandidateProfile();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function deleteEducation(eduId) {
    if (!confirm("Delete education record?")) return;
    try {
      await api(`/candidate/education/${eduId}`, { method: "DELETE" });
      toast("Education record deleted.");
      renderCandidateProfile();
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function deleteExperience(expId) {
    if (!confirm("Delete experience record?")) return;
    try {
      await api(`/candidate/experience/${expId}`, { method: "DELETE" });
      toast("Experience record deleted.");
      renderCandidateProfile();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function openAddEducationModal() {
    $("#modal-root").innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" style="max-width:500px;">
          <div class="modal-head">
            <h3>Add Academic Qualification</h3>
            <button class="icon-btn" onclick="window.jobMatcher.closeModal()"><i data-lucide="x"></i></button>
          </div>
          <form id="add-edu-form" class="modal-body form-grid">
            <div class="form-field full">
              <label>Institution / College / University</label>
              <input class="form-input" name="institution" placeholder="e.g. National Institute of Technology" required />
            </div>
            <div class="form-field">
              <label>Degree</label>
              <input class="form-input" name="degree" placeholder="e.g. B.Tech / B.E. / B.Sc" required />
            </div>
            <div class="form-field">
              <label>Field of Study</label>
              <input class="form-input" name="field_of_study" placeholder="e.g. Computer Science" />
            </div>
            <div class="form-field">
              <label>Start Year</label>
              <input class="form-input" type="number" name="start_year" value="2022" />
            </div>
            <div class="form-field">
              <label>End Year (or Expected)</label>
              <input class="form-input" type="number" name="end_year" value="2026" />
            </div>
            <div class="form-field full">
              <label>Grade / CGPA</label>
              <input class="form-input" name="grade" placeholder="e.g. 8.8 CGPA or 85%" />
            </div>
            <div class="form-field full" style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px;">
              <button type="button" class="btn btn-outline" onclick="window.jobMatcher.closeModal()">Cancel</button>
              <button type="submit" class="btn btn-primary">Save Education</button>
            </div>
          </form>
        </div>
      </div>
    `;
    refreshIcons();

    $("#add-edu-form").onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = {
        institution: fd.get("institution"),
        degree: fd.get("degree"),
        field_of_study: fd.get("field_of_study"),
        start_year: Number(fd.get("start_year")) || null,
        end_year: Number(fd.get("end_year")) || null,
        grade: fd.get("grade")
      };

      try {
        await api("/candidate/education", { method: "POST", body: JSON.stringify(body) });
        closeModal();
        toast("Education record added!");
        renderCandidateProfile();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  function openAddExperienceModal() {
    $("#modal-root").innerHTML = `
      <div class="modal-backdrop">
        <div class="modal" style="max-width:520px;">
          <div class="modal-head">
            <h3>Add Internship / Work Experience</h3>
            <button class="icon-btn" onclick="window.jobMatcher.closeModal()"><i data-lucide="x"></i></button>
          </div>
          <form id="add-exp-form" class="modal-body form-grid">
            <div class="form-field full">
              <label>Company / Organization Name</label>
              <input class="form-input" name="company_name" placeholder="e.g. Google India" required />
            </div>
            <div class="form-field full">
              <label>Job Title / Role</label>
              <input class="form-input" name="role_title" placeholder="e.g. Backend Development Intern" required />
            </div>
            <div class="form-field">
              <label>Location</label>
              <input class="form-input" name="location" placeholder="e.g. Bengaluru" />
            </div>
            <div class="form-field">
              <label>Start Date</label>
              <input class="form-input" type="date" name="start_date" />
            </div>
            <div class="form-field">
              <label>End Date</label>
              <input class="form-input" type="date" name="end_date" />
            </div>
            <div class="form-field" style="display:flex;justify-content:center;align-items:center;">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-top:16px;">
                <input type="checkbox" name="is_current" />
                <span>Currently working here</span>
              </label>
            </div>
            <div class="form-field full">
              <label>Key Responsibilities & Achievements</label>
              <textarea class="form-textarea" name="description" placeholder="Highlights of tech stack used and impact..."></textarea>
            </div>
            <div class="form-field full" style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px;">
              <button type="button" class="btn btn-outline" onclick="window.jobMatcher.closeModal()">Cancel</button>
              <button type="submit" class="btn btn-primary">Save Experience</button>
            </div>
          </form>
        </div>
      </div>
    `;
    refreshIcons();

    $("#add-exp-form").onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = {
        company_name: fd.get("company_name"),
        role_title: fd.get("role_title"),
        location: fd.get("location"),
        start_date: fd.get("start_date") || null,
        end_date: fd.get("end_date") || null,
        is_current: fd.get("is_current") === "on",
        description: fd.get("description")
      };

      try {
        await api("/candidate/experience", { method: "POST", body: JSON.stringify(body) });
        closeModal();
        toast("Experience record added!");
        renderCandidateProfile();
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  // --------------------------------------------------------------------------
  // Global Event Listeners
  // --------------------------------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    // Check active session on load
    checkSession();

    const content = $("#main-content");
    if (content && "MutationObserver" in window) {
      let labelPassPending = false;
      new MutationObserver(() => {
        if (labelPassPending) return;
        labelPassPending = true;
        requestAnimationFrame(() => {
          associateFieldLabels(content);
          labelPassPending = false;
        });
      }).observe(content, { childList: true, subtree: true });
    }

    document.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        if ($("#modal-root").firstElementChild) closeModal();
        $("#sidebar").classList.remove("open");
        $("#notification-popover")?.classList.add("hidden");
        $("#notification-bell")?.setAttribute("aria-expanded", "false");
      }
    });

    const notificationBell = $("#notification-bell");
    const notificationPopover = $("#notification-popover");
    const notificationList = $("#notification-list");
    notificationBell?.addEventListener("click", () => {
      const opening = notificationPopover.classList.contains("hidden");
      notificationPopover.classList.toggle("hidden", !opening);
      notificationBell.setAttribute("aria-expanded", String(opening));
      if (opening) loadNotificationList(true);
    });
    $("#notification-filter")?.addEventListener("change", event => {
      notificationFilter = event.currentTarget.value;
      loadNotificationList(true);
    });
    $("#mark-all-notifications-read")?.addEventListener("click", markAllNotificationsRead);
    $("#notification-load-more")?.addEventListener("click", () => loadNotificationList(false));
    notificationList?.addEventListener("click", event => {
      if (event.target.closest("[data-notification-retry]")) { loadNotificationList(true); return; }
      const readButton = event.target.closest("[data-notification-read]");
      if (readButton) { markNotificationRead(readButton.dataset.notificationRead); return; }
      const openButton = event.target.closest("[data-notification-open]");
      if (openButton) openNotification(openButton.dataset.notificationOpen);
    });
    document.addEventListener("click", event => {
      if (notificationPopover && !$("#notification-center").contains(event.target)) {
        notificationPopover.classList.add("hidden");
        notificationBell?.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && currentUser) {
        refreshNotificationUnreadCount();
        if (!notificationPopover.classList.contains("hidden")) loadNotificationList(true);
      }
    });

    // Landing-page role selection and sign-in use the existing authentication API.
    $$('[data-landing-role]').forEach(button => {
      button.addEventListener('click', () => selectLandingRole(button.dataset.landingRole));
    });
    selectLandingRole("user");

    const landingLoginForm = $("#landing-login-form");
    if (landingLoginForm) {
      landingLoginForm.addEventListener("submit", async event => {
        event.preventDefault();
        if (landingLoginForm.getAttribute("aria-busy") === "true") return;
        if (!landingLoginForm.reportValidity()) return;
        const errorBox = $("#landing-login-error");
        errorBox.textContent = "";
        const body = Object.fromEntries(new FormData(landingLoginForm).entries());
        setFormBusy(landingLoginForm, true);
        try {
          const result = await api("/auth/login", { method: "POST", body: JSON.stringify(body) });
          closeModal();
          toast(result.message);
          setSession(result.user);
        } catch (error) {
          errorBox.textContent = error.message || "Unable to sign in. Check your username, password, and selected workspace.";
        } finally {
          setFormBusy(landingLoginForm, false);
        }
      });
    }

    const landingPasswordToggle = $("[data-landing-password-toggle]");
    if (landingPasswordToggle) {
      landingPasswordToggle.addEventListener("click", () => {
        const input = $("#landing-password");
        const visible = input.type === "password";
        input.type = visible ? "text" : "password";
        landingPasswordToggle.setAttribute("aria-label", visible ? "Hide password" : "Show password");
        landingPasswordToggle.setAttribute("aria-pressed", String(visible));
        landingPasswordToggle.innerHTML = `<i data-lucide="${visible ? 'eye-off' : 'eye'}"></i>`;
        refreshIcons();
      });
    }

    const createAccountButton = $("#landing-create-account");
    if (createAccountButton) {
      createAccountButton.addEventListener("click", () => {
        if (landingRole === "developer") return;
        openAuthModal(landingRole, "register");
      });
    }

    // Header sign-in shortcut focuses the inline form.
    if ($("#hero-quick-login-btn")) {
      $("#hero-quick-login-btn").onclick = () => {
        $("#landing-username")?.focus({ preventScroll: true });
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        $("#landing-auth-panel")?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      };
    }

    const globalSearch = $("#global-search");
    if (globalSearch) globalSearch.addEventListener("keydown", event => {
      if (event.key !== "Enter" || !currentUser || currentUser.role !== "user") return;
      event.preventDefault();
      const query = globalSearch.value.trim();
      loadView("jobs", query);
    });


    // Logout button
    if ($("#logout-btn")) {
      $("#logout-btn").addEventListener("click", handleLogout);
    }

    // Mobile sidebar toggler
    const mobileBtn = $("#mobile-menu-btn");
    const sidebar = $("#sidebar");
    const sidebarClose = $("#sidebar-close");
    if (mobileBtn && sidebar) {
      mobileBtn.onclick = () => sidebar.classList.add("open");
    }
    if (sidebarClose && sidebar) {
      sidebarClose.onclick = () => sidebar.classList.remove("open");
    }
  });

  // Expose global controller for inline onclick helpers
  window.jobMatcher = {
    loadView,
    openAuthModal,
    closeModal,
    openApplyModal,
    openJobDetails,
    toggleSavedJob,
    openSavedJobDetails,
    openStatusModal,
    withdrawApplication,
    reviewCompany,
    openDeveloperCompanyDetails,
    openDeveloperJobDetails,
    openDeveloperOpportunityForm,
    setDeveloperOpportunityStatus,
    reviewRecruiterLinkRequest,
    toggleJobStatus,
    renewJob,
    editJob,
    deleteSkill,
    editSkill,
    deleteAchievement,
    editAchievement,
    editEducation,
    editExperience,
    deleteResume,
    setDefaultResume,
    deleteEducation,
    deleteExperience,
    openAddEducationModal,
    openAddExperienceModal
  };

  window.openAuthModal = openAuthModal;

})();
