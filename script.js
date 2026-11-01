const root = document.documentElement;
const masthead = document.querySelector(".masthead");
const progress = document.querySelector(".progress span");
const menuToggle = document.querySelector(".menu-toggle");
const navLinks = [...document.querySelectorAll(".nav a")];

// Masthead state and reading progress
const onScroll = () => {
  const max = root.scrollHeight - window.innerHeight;
  progress.style.transform = `scaleX(${max > 0 ? window.scrollY / max : 0})`;
  masthead.classList.toggle("is-scrolled", window.scrollY > 8);
};

window.addEventListener("scroll", onScroll, { passive: true });
window.addEventListener("resize", onScroll);
onScroll();

// Mobile menu
const closeMenu = () => {
  document.body.classList.remove("nav-open");
  menuToggle.setAttribute("aria-expanded", "false");
};

menuToggle.addEventListener("click", () => {
  const isOpen = document.body.classList.toggle("nav-open");
  menuToggle.setAttribute("aria-expanded", String(isOpen));
});

navLinks.forEach((link) => link.addEventListener("click", closeMenu));

// Smooth scrolling only for in-page links, so the browser never animates
// scroll restoration or other programmatic scrolls on its own
const smoothScroll = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

document.querySelectorAll('a[href^="#"]').forEach((link) => {
  link.addEventListener("click", (event) => {
    const target = document.querySelector(link.hash);
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: smoothScroll ? "smooth" : "auto" });
    history.pushState(null, "", link.hash);
  });
});

// Highlight the section in view and show it in the running head
const hero = document.querySelector("#top");
const sections = navLinks.map((link) => document.querySelector(link.hash)).filter(Boolean);
const runningHead = document.querySelector(".running-head");

const setRunningHead = (section) => {
  const num = section?.querySelector(".rail-num");
  const title = section?.querySelector(".rail h2");
  runningHead.classList.toggle("is-visible", Boolean(num && title));
  if (!num || !title) return;
  runningHead.replaceChildren(Object.assign(document.createElement("b"), { textContent: num.textContent }), title.textContent);
};

const spy = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const id = entry.target === hero ? null : `#${entry.target.id}`;
      navLinks.forEach((link) => link.classList.toggle("is-active", link.hash === id));
      setRunningHead(entry.target === hero ? null : entry.target);
    });
  },
  { rootMargin: "-40% 0px -55% 0px" }
);

[hero, ...sections].forEach((section) => spy.observe(section));

// Figure viewer
const viewer = document.querySelector(".viewer");
const viewerImg = viewer.querySelector("img");
const viewerMeta = viewer.querySelector(".viewer-meta");
const viewerTitle = viewer.querySelector(".viewer-title");

document.querySelectorAll(".paper-fig").forEach((button) => {
  const paper = button.closest(".paper");
  const title = paper.querySelector(".paper-title").textContent.trim();
  button.setAttribute("aria-label", `Enlarge figure: ${title}`);

  button.addEventListener("click", () => {
    const img = button.querySelector("img");
    viewerImg.src = img.src;
    viewerImg.alt = img.alt;
    viewerMeta.textContent = paper.querySelector(".paper-meta").textContent.trim();
    viewerTitle.textContent = title;
    viewer.showModal();
  });
});

viewer.addEventListener("click", (event) => {
  if (event.target === viewer || event.target.closest(".viewer-close")) {
    viewer.close();
  }
});

// Copy an email address to the clipboard
document.querySelectorAll(".copy").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
    } catch {
      return;
    }
    button.textContent = "Copied";
    button.classList.add("is-done");
    setTimeout(() => {
      button.textContent = "Copy";
      button.classList.remove("is-done");
    }, 1600);
  });
});
