// Mobile Menu Toggle
const mobileMenuToggle = document.getElementById('mobileMenuToggle');
const navMenu = document.getElementById('navMenu');

// Preloader
window.addEventListener('load', () => {
    const preloader = document.getElementById('preloader');
    if (preloader) {
        setTimeout(() => {
            preloader.classList.add('hidden');
        }, 1000);
    }
});

// Scroll Progress Bar
window.addEventListener('scroll', () => {
    const scrollProgress = document.getElementById('scrollProgress');
    if (scrollProgress) {
        const windowHeight = document.documentElement.scrollHeight - document.documentElement.clientHeight;
        const scrolled = (window.pageYOffset / windowHeight) * 100;
        scrollProgress.style.width = scrolled + '%';
    }
});

if (mobileMenuToggle) {
    mobileMenuToggle.addEventListener('click', () => {
        navMenu.classList.toggle('active');
        mobileMenuToggle.classList.toggle('active');
    });

    const navLinks = document.querySelectorAll('.nav-link');
    navLinks.forEach(link => {
        link.addEventListener('click', () => {
            navMenu.classList.remove('active');
            mobileMenuToggle.classList.remove('active');
        });
    });
}

// Navbar Scroll Effect
const navbar = document.getElementById('navbar');
let lastScroll = 0;

window.addEventListener('scroll', () => {
    const currentScroll = window.pageYOffset;

    if (currentScroll > 100) {
        navbar.classList.add('scrolled');
    } else {
        navbar.classList.remove('scrolled');
    }

    lastScroll = currentScroll;
});

// Smooth Scroll for Anchor Links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const href = this.getAttribute('href');

        if (href === '#' || href === '') return;

        e.preventDefault();
        const target = document.querySelector(href);

        if (target) {
            const offsetTop = target.offsetTop - 80;
            window.scrollTo({
                top: offsetTop,
                behavior: 'smooth'
            });
        }
    });
});

// Booking Form Handler
const bookingForm = document.getElementById('bookingForm');

// Toast Notification Function
function showToast(message, type = 'success') {
    const toastContainer = document.getElementById('toast-container');
    if (!toastContainer) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <div class="toast-icon">${type === 'success' ? '✓' : '✕'}</div>
        <div class="toast-message">${message}</div>
    `;

    toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('show');
    }, 100);

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            toastContainer.removeChild(toast);
        }, 300);
    }, 3000);
}

if (bookingForm) {
    bookingForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        const formData = new FormData(bookingForm);
        const data = {
            name: formData.get('name'),
            telegram: formData.get('telegram'),
            sauna: formData.get('sauna'),
            comment: formData.get('comment') || ''
        };

        // Получаем cityKey из глобальной переменной
        const cityKey = window.CITY_KEY || 'tyumen';

        try {
            const response = await fetch(`/api/booking/${cityKey}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            const result = await response.json();

            if (result.success) {
                showToast(`Спасибо, ${data.name}! Ваша заявка принята. Мы свяжемся с вами в ближайшее время.`, 'success');
                bookingForm.reset();
            } else {
                showToast('Произошла ошибка. Попробуйте еще раз.', 'error');
            }
        } catch (error) {
            console.error('Ошибка отправки заявки:', error);
            showToast('Произошла ошибка. Попробуйте еще раз.', 'error');
        }
    });
}

// Scroll Animations
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
};

const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            // Don't unobserve so animation can repeat if needed
        }
    });
}, observerOptions);

const animatedElements = document.querySelectorAll(
    '.sauna-card, .advantage-card, .price-card, .gallery-item, .contact-item, .fade-in-up'
);

animatedElements.forEach(el => {
    observer.observe(el);
});

// Image Loading Handler
document.querySelectorAll('img').forEach(img => {
    img.addEventListener('load', function() {
        this.style.opacity = '1';
        const parent = this.closest('.sauna-image, .gallery-item');
        if (parent) {
            parent.classList.add('loaded');
        }
    });

    img.addEventListener('error', function() {
        this.style.display = 'none';
    });

    // Force immediate load
    if (img.complete) {
        img.style.opacity = '1';
        const parent = img.closest('.sauna-image, .gallery-item');
        if (parent) {
            parent.classList.add('loaded');
        }
    }
});


// Gallery Lightbox
const galleryItems = document.querySelectorAll('.gallery-item');

galleryItems.forEach(item => {
    item.addEventListener('click', () => {
        const img = item.querySelector('img');
        if (img) {
            const lightbox = document.createElement('div');
            lightbox.className = 'lightbox';
            lightbox.innerHTML = `
                <div class="lightbox-content">
                    <span class="lightbox-close">&times;</span>
                    <img src="${img.src}" alt="${img.alt}">
                </div>
            `;

            document.body.appendChild(lightbox);
            document.body.style.overflow = 'hidden';

            const closeBtn = lightbox.querySelector('.lightbox-close');
            closeBtn.addEventListener('click', () => {
                document.body.removeChild(lightbox);
                document.body.style.overflow = 'auto';
            });

            lightbox.addEventListener('click', (e) => {
                if (e.target === lightbox) {
                    document.body.removeChild(lightbox);
                    document.body.style.overflow = 'auto';
                }
            });
        }
    });
});

// Modal for Sauna Details
const saunaDetails = {
    baikal: {
        name: 'Сауна «Байкал»',
        description: 'Окунитесь в мир роскоши и комфорта в нашей самой просторной сауне. Почувствуйте, как тепло финской парной расслабляет каждую мышцу, а освежающий бассейн с гейзерами дарит невероятное ощущение легкости. Цветная подсветка создает волшебную атмосферу для незабываемого отдыха с друзьями.',
        features: [
            'Площадь: 60 м²',
            'Вместимость: до 10 человек',
            'Бассейн 4x6 метров с гейзерами',
            'Цветная подсветка',
            'Финская сауна',
            'Комната отдыха',
            'Обеденная зона',
            'Караоке-система'
        ],
        getPrice: () => window.CITY_PRICES ? `${window.CITY_PRICES.baikal}₽/час` : '3500₽/час'
    },
    taiga: {
        name: 'Сауна «Тайга»',
        description: 'Погрузитесь в атмосферу настоящей сибирской тайги. Аромат натурального дерева, мягкий жар парной и прохлада бассейна создают идеальный баланс для восстановления сил. Уютное пространство располагает к душевным беседам и полному расслаблению.',
        features: [
            'Площадь: 50 м²',
            'Вместимость: до 8 человек',
            'Бассейн 3x5 метров',
            'Финская сауна',
            'Комната отдыха',
            'Обеденная зона',
            'Музыкальная система'
        ],
        getPrice: () => window.CITY_PRICES ? `${window.CITY_PRICES.taiga}₽/час` : '3000₽/час'
    },
    banya: {
        name: 'Русская баня',
        description: 'Ощутите силу традиционной русской бани. Горячий пар, запах березовых веников и контрастная купель — это настоящее очищение тела и души. Закажите профессиональное парение и почувствуйте прилив энергии и обновление.',
        features: [
            'Площадь: 45 м²',
            'Вместимость: до 8 человек',
            'Купель с холодной водой',
            'Русская баня на дровах',
            'Комната отдыха',
            'Обеденная зона',
            'Парение (по запросу)'
        ],
        getPrice: () => window.CITY_PRICES ? `${window.CITY_PRICES.banya}₽/час` : '2500₽/час'
    }
};

function openModal(saunaId) {
    const sauna = saunaDetails[saunaId];
    if (!sauna) return;

    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <span class="modal-close">&times;</span>
            <h2 class="modal-title">${sauna.name}</h2>
            <p class="modal-description">${sauna.description}</p>
            <h3 class="modal-subtitle">Особенности:</h3>
            <ul class="modal-features">
                ${sauna.features.map(f => `<li>${f}</li>`).join('')}
            </ul>
            <div class="modal-price">
                <span class="modal-price-label">Стоимость:</span>
                <span class="modal-price-value">${sauna.getPrice()}</span>
            </div>
            <a href="#booking" class="btn btn-primary btn-large btn-block modal-btn">Забронировать</a>
        </div>
    `;

    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';

    const closeBtn = modal.querySelector('.modal-close');
    closeBtn.addEventListener('click', () => {
        document.body.removeChild(modal);
        document.body.style.overflow = 'auto';
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
            document.body.style.overflow = 'auto';
        }
    });

    const bookingBtn = modal.querySelector('.modal-btn');
    bookingBtn.addEventListener('click', () => {
        document.body.removeChild(modal);
        document.body.style.overflow = 'auto';
    });
}

// Set minimum date for booking form
const dateInput = document.querySelector('input[type="date"]');
if (dateInput) {
    const today = new Date().toISOString().split('T')[0];
    dateInput.setAttribute('min', today);
}

// Phone number formatting
const phoneInput = document.querySelector('input[type="tel"]');
if (phoneInput) {
    phoneInput.addEventListener('input', (e) => {
        let value = e.target.value.replace(/\D/g, '');
        if (value.length > 11) value = value.slice(0, 11);

        if (value.length > 0) {
            if (value[0] === '8') value = '7' + value.slice(1);
            if (value[0] !== '7') value = '7' + value;
        }

        let formatted = '+7';
        if (value.length > 1) formatted += ' (' + value.slice(1, 4);
        if (value.length >= 5) formatted += ') ' + value.slice(4, 7);
        if (value.length >= 8) formatted += '-' + value.slice(7, 9);
        if (value.length >= 10) formatted += '-' + value.slice(9, 11);

        e.target.value = formatted;
    });
}

// Ripple effect on buttons
document.querySelectorAll('.btn').forEach(button => {
    button.addEventListener('click', function(e) {
        const ripple = document.createElement('span');
        ripple.classList.add('ripple');

        const rect = this.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        const x = e.clientX - rect.left - size / 2;
        const y = e.clientY - rect.top - size / 2;

        ripple.style.width = ripple.style.height = size + 'px';
        ripple.style.left = x + 'px';
        ripple.style.top = y + 'px';

        this.appendChild(ripple);

        setTimeout(() => {
            ripple.remove();
        }, 600);
    });
});
