import React from 'react';
import './App.css';

const EcoFutureLandingPage = () => {
    return (
        <div className="container">
            <header className="hero">
                <h1>Welcome to EcoFuture</h1>
                <p>Join us in making a positive impact on the environment.</p>
                <button className="cta">Join the Movement</button>
            </header>
            <section className="section">
                <h2>About Us</h2>
                <p>EcoFuture is dedicated to promoting environmental sustainability through innovative initiatives.</p>
            </section>
            <section className="section">
                <h2>Our Initiatives</h2>
                <p>Learn about our current projects aimed at improving our planet.</p>
            </section>
            <section className="section">
                <h2>Get Involved</h2>
                <p>Discover ways you can volunteer or donate to our cause.</p>
            </section>
            <section className="section">
                <h2>Testimonials</h2>
                <blockquote>"EcoFuture's work is inspiring!" - Supporter</blockquote>
            </section>
            <section className="section">
                <h2>Blog</h2>
                <p>Read our latest articles on environmental topics.</p>
            </section>
            <section className="section">
                <h2>Contact Us</h2>
                <form>
                    <div className="form-group">
                        <input type="text" placeholder="Your Name" required />
                    </div>
                    <div className="form-group">
                        <input type="email" placeholder="Your Email" required />
                    </div>
                    <div className="form-group">
                        <textarea placeholder="Your Message" required></textarea>
                    </div>
                    <button type="submit" className="cta">Send Message</button>
                </form>
            </section>
        </div>
    );
};

export default EcoFutureLandingPage;