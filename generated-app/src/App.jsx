import React from 'react';
import './App.css';

const CulinaryDelights = () => {
    return (
        <div>
            <header>
                <h1>Culinary Delights</h1>
                <a className="cta" href="#reservation">Make a Reservation</a>
            </header>
            <div className="container">
                <section className="section" id="menu">
                    <h2>Menu Highlights</h2>
                    <p>Discover our special dishes prepared by the finest chefs.</p>
                </section>
                <section className="section" id="ambience">
                    <h2>Ambience</h2>
                    <p>Experience a welcoming and sophisticated dining atmosphere.</p>
                </section>
                <section className="section" id="chefs-story">
                    <h2>Chef's Story</h2>
                    <p>Learn about our chef's journey and passion for culinary arts.</p>
                </section>
                <section className="section" id="location-hours">
                    <h2>Hours & Location</h2>
                    <p>Visit us at our convenient location during our open hours!</p>
                </section>
                <section className="section feedback-form">
                    <h2>Feedback</h2>
                    <form>
                        <input type="email" placeholder="Your Email" required />
                        <div className="rating">
                            <label className="rating-label">Rating:</label>
                            <select required>
                                <option value="5">⭐️⭐️⭐️⭐️⭐️</option>
                                <option value="4">⭐️⭐️⭐️⭐️</option>
                                <option value="3">⭐️⭐️⭐️</option>
                                <option value="2">⭐️⭐️</option>
                                <option value="1">⭐️</option>
                            </select>
                        </div>
                        <textarea rows="4" placeholder="Your Comments" required></textarea>
                        <button type="submit" className="cta">Submit Feedback</button>
                    </form>
                </section>
            </div>
            <footer>
                <p>Thank you for visiting us!</p>
            </footer>
        </div>
    );
};

export default CulinaryDelights;