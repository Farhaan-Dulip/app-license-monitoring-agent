import React from 'react';
import './App.css';

const App = () => {
    return (
        <div>
            <header>
                <nav>
                    <ul>
                        <li><a href="#menu">Menu</a></li>
                        <li><a href="#ambience">Ambience</a></li>
                        <li><a href="#story">Chef's Story</a></li>
                        <li><a href="#hours">Location & Hours</a></li>
                        <li><a href="#events">Events</a></li>
                    </ul>
                </nav>
                <div className="hero">
                    <h1>Welcome to Savory Delights</h1>
                    <button className="cta">Make a Reservation</button>
                </div>
            </header>
            <section className="section" id="menu">
                <h2>Menu Highlights</h2>
                <div className="menu">
                    <div className="menu-item">
                        <h3>Pasta Primavera</h3>
                        <p>Fresh vegetables with homemade noodles.</p>
                    </div>
                    <div className="menu-item">
                        <h3>Grilled Salmon</h3>
                        <p>Served with lemon butter sauce.</p>
                    </div>
                    <div className="menu-item">
                        <h3>Chocolate Lava Cake</h3>
                        <p>Rich chocolate with a gooey center.</p>
                    </div>
                </div>
            </section>
            <section className="section" id="ambience">
                <h2>Ambience & Decor</h2>
                <div className="ambience">
                    <div className="ambience-item">
                        <h3>Elegant Dining</h3>
                        <p>Experience fine dining in a warm atmosphere.</p>
                    </div>
                    <div className="ambience-item">
                        <h3>Cozy Seating</h3>
                        <p>Perfect for family gatherings or intimate dates.</p>
                    </div>
                </div>
            </section>
            <section className="section" id="story">
                <h2>Chef's Story</h2>
                <p>Our chef believes in crafting enticing dishes from the heart.</p>
            </section>
            <section className="section" id="hours">
                <h2>Hours of Operation & Location</h2>
                <p>Open Daily: 10 AM - 10 PM</p>
                <p>123 Flavor Ave, Taste City, TC 45678</p>
            </section>
            <section className="section" id="events">
                <h2>Private Dining & Events</h2>
                <p>Book our place for special occasions.</p>
            </section>
            <footer>
                <p>&copy; 2023 Savory Delights. All rights reserved.</p>
            </footer>
        </div>
    );
};

export default App;