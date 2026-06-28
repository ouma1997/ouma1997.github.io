const body = document.body;
const menuToggle = document.querySelector(".menu-toggle");
const navLinks = [...document.querySelectorAll(".nav-link")];
const header = document.querySelector(".site-header");
const navItems = navLinks
  .map((link) => ({
    link,
    target: document.querySelector(link.getAttribute("href")),
  }))
  .filter((item) => item.target);

const setActiveLink = (activeId) => {
  navLinks.forEach((link) => {
    link.classList.toggle("active", link.getAttribute("href") === activeId);
  });
};

const updateActiveLink = () => {
  if (!navItems.length) {
    return;
  }

  const headerOffset = header ? header.offsetHeight : 0;
  const threshold = window.scrollY + headerOffset + 24;
  let activeId = navItems[0].link.getAttribute("href");

  navItems.forEach(({ link, target }) => {
    if (target.offsetTop <= threshold) {
      activeId = link.getAttribute("href");
    }
  });

  const nearBottom =
    window.innerHeight + window.scrollY >=
    document.documentElement.scrollHeight - 2;

  if (nearBottom) {
    activeId = navItems[navItems.length - 1].link.getAttribute("href");
  }

  setActiveLink(activeId);
};

const sectionTargets = navItems
  .map((item) => item.target)
  .filter(Boolean);

if (menuToggle) {
  menuToggle.addEventListener("click", () => {
    const isOpen = body.classList.toggle("nav-open");
    menuToggle.setAttribute("aria-expanded", String(isOpen));
  });
}

navLinks.forEach((link) => {
  link.addEventListener("click", () => {
    body.classList.remove("nav-open");
    if (menuToggle) {
      menuToggle.setAttribute("aria-expanded", "false");
    }
  });
});

if (sectionTargets.length) {
  updateActiveLink();
  window.addEventListener("scroll", updateActiveLink, { passive: true });
  window.addEventListener("resize", updateActiveLink);
}
