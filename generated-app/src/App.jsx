import React from 'react';
import './App.css';

const GourmetBistroLandingPage = () => {
    return (
        <div>
            <header>
                <nav>
                    <ul>
                        <li>Home</li>
                        <li>Menu</li>
                        <li>About</li>
                        <li>Contact</li>
                    </ul>
                </nav>
            </header>
            <div className="hero">
                <h1>Welcome to Gourmet Bistro</h1>
            </div>
            <div className="section">
                <h2>Reserve Your Table</h2>
                <button className="cta">Book a Reservation</button>
            </div>
            <div className="section">
                <h2>Menu Highlights</h2>
                <div className="menu-item">
                    <span>Spaghetti Carbonara</span>
                    <span>$15</span>
                </div>
                <div className="menu-item">
                    <span>Grilled Salmon</span>
                    <span>$20</span>
                </div>
                <div className="menu-item">
                    <span>Chocolate Lava Cake</span>
                    <span>$8</span>
                </div>
            </div>
            <div className="section">
                <h2>Ambiance and Decor</h2>
                <p>Experience a cozy and elegant atmosphere perfect for family gatherings and romantic dinners.</p>
            </div>
            <div className="section">
                <h2>Meet Our Chef</h2>
                <p>Our chef brings a wealth of experience and passion for culinary excellence.</p>
            </div>
            <div className="section">
                <h2>Hours and Location</h2>
                <p>Open daily from 11 AM to 10 PM</p>
                <p>123 Gourmet St, Foodie City</p>
            </div>
            <div className="section">
                <h2>Private Dining and Events</h2>
                <p>Book our private space for your next event!</p>
            </div>
            <footer>
                <p>&copy; 2023 Gourmet Bistro</p>
            </footer>
        </div>
    );
};

export default GourmetBistroLandingPage;