const revealNodes = document.querySelectorAll("[data-reveal]");
const previewModal = document.querySelector(".preview-modal");
const previewImage = document.querySelector(".preview-image");
const previewTitle = document.querySelector("#preview-title");
const previewBody = document.querySelector(".preview-body");
const previewCloseTargets = document.querySelectorAll("[data-preview-close]");
const tourStageFrame = document.querySelector(".tour-stage-frame");
const tourStageImage = document.querySelector(".tour-stage-image");
const tourStageKicker = document.querySelector(".tour-stage-kicker");
const tourStageTitle = document.querySelector(".tour-stage-title");
const tourStageBody = document.querySelector(".tour-stage-body");
const tourStageCounter = document.querySelector(".tour-stage-counter");
const tourDots = document.querySelectorAll(".tour-dot");
let lastFocusedCard = null;
let activeTourIndex = 0;
let tourIntervalId = null;

if ("IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    {
      threshold: 0.14,
      rootMargin: "0px 0px -30px 0px",
    }
  );

  revealNodes.forEach((node) => observer.observe(node));
} else {
  revealNodes.forEach((node) => node.classList.add("is-visible"));
}

const closePreview = () => {
  if (!previewModal || previewModal.hidden) return;
  previewModal.hidden = true;
  previewModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  if (lastFocusedCard) {
    lastFocusedCard.focus();
  }
};

const openPreview = ({ src, alt, title, body }, focusTarget = null) => {
  if (!previewModal || !previewImage || !previewTitle || !previewBody) return;
  lastFocusedCard = focusTarget;
  previewImage.src = src;
  previewImage.alt = alt;
  previewTitle.textContent = title;
  previewBody.textContent = body;
  previewModal.hidden = false;
  previewModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
};

const renderTourSlide = (index) => {
  if (!tourDots.length || !tourStageImage || !tourStageKicker || !tourStageTitle || !tourStageBody || !tourStageCounter) {
    return;
  }

  const safeIndex = (index + tourDots.length) % tourDots.length;
  const activeItem = tourDots[safeIndex];

  tourDots.forEach((item, itemIndex) => {
    item.classList.toggle("is-active", itemIndex === safeIndex);
  });

  tourStageImage.src = activeItem.dataset.tourImage || "";
  tourStageImage.alt = activeItem.dataset.tourAlt || "";
  tourStageImage.style.objectFit = activeItem.dataset.tourFit || "cover";
  tourStageImage.style.objectPosition = activeItem.dataset.tourPosition || "center top";
  tourStageKicker.textContent = activeItem.dataset.tourKicker || "";
  tourStageTitle.textContent = activeItem.dataset.tourTitle || "";
  tourStageBody.textContent = activeItem.dataset.tourBody || "";
  tourStageCounter.textContent = `${String(safeIndex + 1).padStart(2, "0")} / ${String(tourDots.length).padStart(2, "0")}`;
  activeTourIndex = safeIndex;
};

const restartTourAutoplay = () => {
  if (!tourDots.length) return;
  if (tourIntervalId) {
    window.clearInterval(tourIntervalId);
  }
  tourIntervalId = window.setInterval(() => {
    renderTourSlide(activeTourIndex + 1);
  }, 3600);
};

tourDots.forEach((item, index) => {
  item.addEventListener("click", () => {
    renderTourSlide(index);
    restartTourAutoplay();
  });
});

if (tourStageFrame) {
  tourStageFrame.addEventListener("click", () => {
    openPreview(
      {
        src: tourStageImage?.src || "",
        alt: tourStageImage?.alt || "",
        title: tourStageTitle?.textContent || "",
        body: tourStageBody?.textContent || "",
      },
      tourStageFrame
    );
  });
}

if (tourDots.length) {
  renderTourSlide(0);
  restartTourAutoplay();
}

previewCloseTargets.forEach((target) => {
  target.addEventListener("click", closePreview);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closePreview();
  }
});
