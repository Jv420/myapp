const productsElement = document.getElementById('products');
const playerElement = document.getElementById('player');
const messageElement = document.getElementById('message');

function formatPrice(cents, currency) {
  return new Intl.NumberFormat('nl-NL', {
    style: 'currency',
    currency: String(currency || 'eur').toUpperCase()
  }).format(cents / 100);
}

async function startCheckout(productId, button) {
  const player = playerElement.value.trim();
  messageElement.className = 'message';
  messageElement.textContent = '';

  if (!/^[A-Za-z0-9_]{3,16}$/.test(player)) {
    messageElement.className = 'message error';
    messageElement.textContent = 'Vul een geldige Minecraft Java-naam van 3 tot 16 tekens in.';
    playerElement.focus();
    return;
  }

  button.disabled = true;
  button.textContent = 'Checkout laden...';

  try {
    const response = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player, product: productId })
    });
    const result = await response.json();
    if (!response.ok || !result.url) throw new Error(result.message || 'Checkout kon niet worden gestart');
    window.location.href = result.url;
  } catch (error) {
    messageElement.className = 'message error';
    messageElement.textContent = error.message;
    button.disabled = false;
    button.textContent = 'Kopen';
  }
}

async function loadProducts() {
  try {
    const response = await fetch('/api/products');
    const result = await response.json();
    if (!response.ok) throw new Error('Producten konden niet worden geladen');

    productsElement.innerHTML = '';
    for (const product of result.products) {
      const card = document.createElement('article');
      card.className = 'product';
      card.innerHTML = `
        <p class="eyebrow">${product.id.replaceAll('_', ' ')}</p>
        <h3>${product.name}</h3>
        <p>${product.description}</p>
        <p class="price">${formatPrice(product.priceCents, product.currency)}</p>
      `;
      const button = document.createElement('button');
      button.className = 'button primary';
      button.textContent = 'Kopen';
      button.addEventListener('click', () => startCheckout(product.id, button));
      card.appendChild(button);
      productsElement.appendChild(card);
    }
  } catch (error) {
    productsElement.innerHTML = `<p class="error">${error.message}</p>`;
  }
}

loadProducts();
