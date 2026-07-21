import React from 'react';
import './App.css';

const App = () => {
    return (
        <div className="container">
            <h1>Welcome to Deli Delight - Your Favorite Sandwich Spot</h1>
            <h2>We value your feedback to improve our services</h2>
            <div className="section">
                <p>Check out our menu with the freshest ingredients. Special offers and promotions for our customers await!</p>
            </div>
            <form className="feedback-form">
                <div className="form-group">
                    <label htmlFor="email">Email Address</label>
                    <input type="email" id="email" name="email" required placeholder="you@example.com" />
                </div>
                <div className="form-group">
                    <label>Rate your experience:</label>
                    <div className="rating">
                        <input type="radio" name="rating" id="star1" value="1" />
                        <label htmlFor="star1">★</label>
                        <input type="radio" name="rating" id="star2" value="2" />
                        <label htmlFor="star2">★</label>
                        <input type="radio" name="rating" id="star3" value="3" />
                        <label htmlFor="star3">★</label>
                        <input type="radio" name="rating" id="star4" value="4" />
                        <label htmlFor="star4">★</label>
                        <input type="radio" name="rating" id="star5" value="5" />
                        <label htmlFor="star5">★</label>
                    </div>
                </div>
                <div className="form-group">
                    <label htmlFor="comments">Comments</label>
                    <textarea id="comments" name="comments" rows="4" placeholder="Write your comments here..."></textarea>
                </div>
                <button type="submit">Leave Feedback</button>
            </form>
        </div>
    );
};

export default App;